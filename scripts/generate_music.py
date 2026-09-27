#!/usr/bin/env python3
"""Music generator for the `alpha.music` task (src/agent/handlers/alpha-music.js).

The handler owns the contract and pins it in tests; this script implements it:

    generate_music.py --genre G --subgenre S --bpm N --key "F minor"
                      (--vocals | --instrumental) --seed N --duration N
                      --output-dir DIR

It writes one WAV (plus a small JSON sidecar saying what produced it) into
DIR, names the files itself, and exits non-zero on any failure. The handler
reports whatever lands in DIR and treats a clean exit with nothing written as
a failure, so every error path here must exit non-zero.

The model is MusicGen through Hugging Face `transformers`, which installs with
plain pip on Windows and Linux (audiocraft pins an old torch and often does
not). Install on the generating machine only:

    pip install -r scripts/requirements-music.txt

MusicGen is instrumental only, so `--vocals` is refused. The handler already
refuses `vocals: true` unless the machine sets ALPHA_MUSIC_VOCALS=1; this is
the second half of that rule, for a machine that set it by mistake.

Environment (all optional):
    ALPHA_MUSICGEN_MODEL   Hugging Face model id. Default facebook/musicgen-small
                           (about 4 GB of VRAM, runs slowly on CPU). musicgen-medium
                           wants about 8 GB or more; the -stereo- variants work too.
    ALPHA_MUSICGEN_DEVICE  cuda, mps or cpu. Default: the best one available.
    ALPHA_MUSIC_DRY_RUN    1 writes a click track at the requested BPM on the key's
                           tonic instead of loading a model. It needs nothing beyond
                           the standard library, proves the pipeline end to end, and
                           is what the test suite runs.

Reproducibility: the seed fixes torch's RNG, so the same recipe on the same
machine, model and library versions gives the same track. Across GPUs or
versions it gives a closely related one, not a bit-identical file.
"""

from __future__ import annotations

import argparse
import array
import json
import math
import os
import re
import sys
import time
import wave
from pathlib import Path

DEFAULT_MODEL = "facebook/musicgen-small"
# MusicGen was trained on 30-second clips; past that it drifts. Longer tracks
# are built by continuation: each new window is prompted with the tail of the
# audio so far, so it carries the groove on instead of starting over.
WINDOW_SEC = 30
OVERLAP_SEC = 10
MAX_DURATION_SEC = 300  # the handler's own ceiling

ROOT_SEMITONES = {
    "C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
    "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11,
}
KEY_PATTERN = re.compile(r"^(C#?|D#?|E|F#?|G#?|A#?|B) (major|minor)$")

EXIT_FAILED = 1
EXIT_USAGE = 2  # argparse's own
EXIT_VOCALS = 3


class Refusal(Exception):
    """A request this generator cannot honour; exits with `code`."""

    def __init__(self, message: str, code: int = EXIT_USAGE):
        super().__init__(message)
        self.code = code


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--genre", required=True)
    parser.add_argument("--subgenre", required=True)
    parser.add_argument("--bpm", required=True, type=int)
    parser.add_argument("--key", required=True)
    voice = parser.add_mutually_exclusive_group(required=True)
    voice.add_argument("--vocals", dest="vocals", action="store_true")
    voice.add_argument("--instrumental", dest="vocals", action="store_false")
    parser.add_argument("--seed", required=True, type=int)
    parser.add_argument("--duration", required=True, type=int)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args(argv)

    # The handler validated all of this already. Checking again costs nothing
    # and keeps the script honest when someone runs it by hand.
    if not 30 <= args.bpm <= 300:
        raise Refusal(f"--bpm must be 30-300 (got {args.bpm})")
    if not KEY_PATTERN.match(args.key):
        raise Refusal(f'--key must look like "F minor" or "C# major" (got {args.key!r})')
    if not 1 <= args.duration <= MAX_DURATION_SEC:
        raise Refusal(f"--duration must be 1-{MAX_DURATION_SEC} seconds (got {args.duration})")
    if args.seed < 0:
        raise Refusal(f"--seed must be non-negative (got {args.seed})")
    if not args.output_dir.is_dir():
        raise Refusal(f"--output-dir does not exist: {args.output_dir}")
    if args.vocals:
        raise Refusal(
            "MusicGen is instrumental only and cannot sing; ask for --instrumental, "
            "or unset ALPHA_MUSIC_VOCALS on this machine",
            EXIT_VOCALS,
        )
    return args


def build_prompt(args: argparse.Namespace) -> str:
    """The text MusicGen is conditioned on. Recorded in the sidecar, so a track
    can be traced back to exactly what the model was told."""
    return (
        f"{args.subgenre} {args.genre.lower()} track, {args.bpm} BPM, in {args.key}, "
        "instrumental, no vocals, high quality studio production"
    )


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def base_name(args: argparse.Namespace) -> str:
    return (
        f"{slug(args.subgenre)}_{args.bpm}bpm_{slug(args.key.replace('#', ' sharp'))}"
        f"_seed{args.seed}_{args.duration}s"
    )


def write_wav(path: Path, samples: array.array, sample_rate: int, channels: int) -> None:
    """16-bit PCM, interleaved. `samples` is an array('h')."""
    with wave.open(str(path), "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(2)
        out.setframerate(sample_rate)
        out.writeframes(samples.tobytes())


def tonic_hz(key: str) -> float:
    root = KEY_PATTERN.match(key).group(1)
    # The tonic in the octave starting at A3 (220 Hz): audible on any speaker.
    semitones_from_a = (ROOT_SEMITONES[root] - ROOT_SEMITONES["A"]) % 12
    return 220.0 * 2 ** (semitones_from_a / 12)


def dry_run(args: argparse.Namespace) -> tuple[array.array, int, int, str]:
    """A click on every beat at the tonic, accented on the downbeat. Proves the
    BPM, key and duration made it all the way through without a model."""
    rate = 16_000
    total = rate * args.duration
    beat = 60.0 / args.bpm
    click = int(rate * 0.05)
    freq = tonic_hz(args.key)
    samples = array.array("h", bytes(2 * total))
    n = 0
    while True:
        start = int(n * beat * rate)
        if start >= total:
            break
        gain = 0.8 if n % 4 == 0 else 0.4
        pitch = freq * (2 if n % 4 == 0 else 1)
        for i in range(min(click, total - start)):
            envelope = 1 - i / click
            samples[start + i] = int(32767 * gain * envelope * math.sin(2 * math.pi * pitch * i / rate))
        n += 1
    return samples, rate, 1, "dry-run (click track)"


def generate(args: argparse.Namespace, prompt: str) -> tuple[array.array, int, int, str]:
    # Imported here so --help, validation and the dry run need none of it.
    try:
        import torch
        from transformers import AutoProcessor, MusicgenForConditionalGeneration
    except ImportError as error:
        raise Refusal(
            f"{error}. Install the generator's dependencies on this machine: "
            "pip install -r scripts/requirements-music.txt",
            EXIT_FAILED,
        ) from error

    model_id = os.environ.get("ALPHA_MUSICGEN_MODEL", "").strip() or DEFAULT_MODEL
    device = os.environ.get("ALPHA_MUSICGEN_DEVICE", "").strip()
    if not device:
        if torch.cuda.is_available():
            device = "cuda"
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"

    torch.manual_seed(args.seed)
    if device == "cuda":
        torch.cuda.manual_seed_all(args.seed)

    processor = AutoProcessor.from_pretrained(model_id)
    model = MusicgenForConditionalGeneration.from_pretrained(model_id).to(device)
    model.eval()
    rate = model.config.audio_encoder.sampling_rate
    frame_rate = model.config.audio_encoder.frame_rate  # codec tokens per second

    def run(seconds: int, audio_prompt=None):
        kwargs = {"text": [prompt], "padding": True, "return_tensors": "pt"}
        if audio_prompt is not None:
            kwargs["audio"] = audio_prompt
            kwargs["sampling_rate"] = rate
        inputs = processor(**kwargs).to(device)
        with torch.no_grad():
            out = model.generate(
                **inputs,
                do_sample=True,
                guidance_scale=3.0,
                max_new_tokens=int(seconds * frame_rate),
            )
        return out[0].float().cpu()  # (channels, samples)

    first = min(args.duration, WINDOW_SEC)
    audio = run(first)
    while audio.shape[-1] < args.duration * rate:
        remaining = args.duration - audio.shape[-1] / rate
        step = min(WINDOW_SEC - OVERLAP_SEC, math.ceil(remaining))
        tail = audio[:, -OVERLAP_SEC * rate:]
        prompt_audio = tail[0].numpy() if tail.shape[0] == 1 else tail.numpy()
        continued = run(OVERLAP_SEC + step, prompt_audio)
        # The output starts with the prompt audio re-decoded; keep only what is new.
        audio = torch.cat([audio, continued[:, tail.shape[-1]:]], dim=-1)

    audio = audio[:, : args.duration * rate]
    channels = audio.shape[0]
    pcm = (audio.clamp(-1, 1) * 32767).round().to(torch.int16)
    interleaved = pcm.t().contiguous().numpy().tobytes()  # frames of (L, R, ...)
    samples = array.array("h")
    samples.frombytes(interleaved)
    return samples, rate, channels, f"{model_id} on {device}"


def main(argv: list[str]) -> int:
    try:
        args = parse_args(argv)
        prompt = build_prompt(args)
        started = time.monotonic()
        if os.environ.get("ALPHA_MUSIC_DRY_RUN", "").strip() == "1":
            samples, rate, channels, engine = dry_run(args)
        else:
            samples, rate, channels, engine = generate(args, prompt)
        if len(samples) == 0:
            raise Refusal("the model returned no audio", EXIT_FAILED)

        name = base_name(args)
        wav = args.output_dir / f"{name}.wav"
        write_wav(wav, samples, rate, channels)
        sidecar = {
            "recipe": {
                "genre": args.genre,
                "subgenre": args.subgenre,
                "bpm": args.bpm,
                "key": args.key,
                "vocals": False,
                "seed": args.seed,
                "durationSec": args.duration,
            },
            "prompt": prompt,
            "engine": engine,
            "sampleRate": rate,
            "channels": channels,
            "generatedInSec": round(time.monotonic() - started, 2),
        }
        (args.output_dir / f"{name}.json").write_text(json.dumps(sidecar, indent=2) + "\n")
        print(f"wrote {wav.name} ({engine}, {len(samples) // channels / rate:.1f}s)")
        return 0
    except Refusal as refusal:
        print(f"generate_music: {refusal}", file=sys.stderr)
        return refusal.code
    except Exception as error:  # noqa: BLE001 — any failure must be a non-zero exit
        print(f"generate_music: {type(error).__name__}: {error}", file=sys.stderr)
        return EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
