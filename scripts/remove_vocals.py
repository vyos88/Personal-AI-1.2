#!/usr/bin/env python3
"""Vocal remover for the `alpha.music.stems` task
(src/agent/handlers/alpha-music-stems.js).

The handler owns the contract and pins it in tests; this script implements it:

    remove_vocals.py --input PATH --output-dir DIR

It writes exactly one file into DIR — PATH with its vocals removed, named by
this script as "<input stem>.novocals<input suffix>" — and exits non-zero on
any failure. The handler reports whatever lands in DIR and treats a clean exit
with nothing written as a failure, so every error path here must exit
non-zero.

Separation is Demucs (https://github.com/facebookresearch/demucs) in its
two-stem mode, which only renders "vocals" and "everything else" instead of
Demucs's usual four stems, and is faster for it. Install on the generating
machine only:

    pip install -r scripts/requirements-stems.txt

Environment (all optional):
    ALPHA_DEMUCS_MODEL     Demucs model name. Default htdemucs.
    ALPHA_DEMUCS_DEVICE    cuda, mps or cpu. Default: the best one available.
    ALPHA_MUSIC_DRY_RUN    1 copies the input to the output unchanged instead
                            of loading a model. There is no way to prove
                            separation itself without a real voice to remove,
                            so this only proves the pipeline end to end — the
                            same honesty generate_music.py's click track has
                            about BPM and key, not musicality. It is what the
                            test suite runs.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

EXIT_FAILED = 1
EXIT_USAGE = 2  # argparse's own

SUFFIX = ".novocals"


class Refusal(Exception):
    """A request this script cannot honour; exits with `code`."""

    def __init__(self, message: str, code: int = EXIT_USAGE):
        super().__init__(message)
        self.code = code


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args(argv)

    # The handler already confirmed the input exists; checking again costs
    # nothing and keeps this script honest when someone runs it by hand.
    if not args.input.is_file():
        raise Refusal(f"--input does not exist: {args.input}")
    if not args.output_dir.is_dir():
        raise Refusal(f"--output-dir does not exist: {args.output_dir}")
    return args


def output_name(input_path: Path) -> str:
    return f"{input_path.stem}{SUFFIX}{input_path.suffix}"


def dry_run(args: argparse.Namespace) -> Path:
    """Copies the input unchanged. Proves the file moved through the pipeline
    without a model; it cannot prove separation without a real voice."""
    dest = args.output_dir / output_name(args.input)
    shutil.copyfile(args.input, dest)
    return dest


def separate(args: argparse.Namespace) -> Path:
    # Imported here so --help and the dry run need none of it.
    try:
        import torch
        from demucs.apply import apply_model
        from demucs.audio import AudioFile, save_audio
        from demucs.pretrained import get_model
    except ImportError as error:
        raise Refusal(
            f"{error}. Install the vocal remover's dependencies on this machine: "
            "pip install -r scripts/requirements-stems.txt",
            EXIT_FAILED,
        ) from error

    model_name = os.environ.get("ALPHA_DEMUCS_MODEL", "").strip() or "htdemucs"
    device = os.environ.get("ALPHA_DEMUCS_DEVICE", "").strip()
    if not device:
        if torch.cuda.is_available():
            device = "cuda"
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"

    model = get_model(model_name)
    model.to(device)
    model.eval()

    wav = AudioFile(str(args.input)).read(
        streams=0, samplerate=model.samplerate, channels=model.audio_channels
    )
    # Demucs normalises before separating and expects to be told how to scale
    # back; a silent or near-silent input would otherwise divide by ~0.
    ref = wav.mean(0)
    std = ref.std()
    normalised = (wav - ref.mean()) / std if std > 1e-8 else wav - ref.mean()

    with torch.no_grad():
        sources = apply_model(model, normalised[None], device=device, split=True, overlap=0.25)[0]
    if std > 1e-8:
        sources = sources * std + ref.mean()
    else:
        sources = sources + ref.mean()

    instrumental = None
    for name, source in zip(model.sources, sources):
        if name == "vocals":
            continue
        instrumental = source if instrumental is None else instrumental + source
    if instrumental is None:
        # Every Demucs model separates a "vocals" stem; this would mean a
        # model whose source list is something else entirely.
        raise Refusal(f"model {model_name!r} has no non-vocal stems to keep", EXIT_FAILED)

    dest = args.output_dir / output_name(args.input)
    save_audio(instrumental, str(dest), model.samplerate)
    return dest


def main(argv: list[str]) -> int:
    try:
        args = parse_args(argv)
        if os.environ.get("ALPHA_MUSIC_DRY_RUN", "").strip() == "1":
            dest = dry_run(args)
        else:
            dest = separate(args)
        print(f"wrote {dest.name}")
        return 0
    except Refusal as refusal:
        print(f"remove_vocals: {refusal}", file=sys.stderr)
        return refusal.code
    except Exception as error:  # noqa: BLE001 — any failure must be a non-zero exit
        print(f"remove_vocals: {type(error).__name__}: {error}", file=sys.stderr)
        return EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
