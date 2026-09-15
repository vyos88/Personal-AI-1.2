import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  available,
  buildArgs,
  rejectUnsupportedParams,
  run,
  validateSeed,
  validateSpecies,
} from '../src/agent/handlers/alpha-render.js';
import * as renderHandler from '../src/agent/handlers/alpha-render.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';

const isWindows = process.platform === 'win32';

/**
 * A throwaway render root whose "Blender" records the argv it was handed and
 * writes the image it was told to write.
 *
 * Recording the argv is the point: argument construction is exactly the part
 * that cannot be guessed at, because the generator script on the other side
 * parses it. `writeImage: false` stands in for a generator that exits cleanly
 * having produced nothing, which is the failure worth catching.
 */
async function fixture({ exitCode = 0, stderr = '', writeImage = true, recordNice = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'alpha-render-'));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'output'), { recursive: true });
  await writeFile(join(root, 'scripts', 'generate.py'), '# stub generator\n');

  const argvLog = join(root, 'argv.json');
  const niceLog = join(root, 'nice.txt');
  const blender = join(root, isWindows ? 'blender.cmd' : 'blender.sh');

  if (isWindows) {
    // Node refuses to execFile a .cmd without shell:true, which would re-parse
    // the argument boundaries these tests exist to pin. So the recorder is
    // node itself, invoked through a small .js shim.
    const shim = join(root, 'blender-shim.js');
    await writeFile(
      shim,
      [
        "const { writeFileSync, copyFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));`,
        // Mirror the POSIX branch: honour --out the way a generator would.
        'const i = process.argv.indexOf("--output-dir");',
        'const sp = process.argv[process.argv.indexOf("--species") + 1];',
        'const sd = process.argv[process.argv.indexOf("--seed") + 1];',
        `if (i !== -1 && ${writeImage}) writeFileSync(require('node:path').join(process.argv[i + 1], sp + "-" + sd + ".png"), "png");`,
        `if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});`,
        `process.exit(${exitCode});`,
      ].join('\n'),
    );
    return { root, argvLog, niceLog, blender: process.execPath, blenderArgs: [shim] };
  }

  await writeFile(
    blender,
    [
      '#!/usr/bin/env bash',
      // "$@" keeps every argument exactly as received, one JSON string each.
      `printf '%s\\n' "$@" | node -e "` +
        `const fs=require('node:fs');` +
        `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>` +
        `fs.writeFileSync(process.argv[1],JSON.stringify(d.split('\\n').slice(0,-1))))` +
        `" ${argvLog}`,
      // Honour --out, the way the real generator is expected to.
      'dir=""; sp=""; sd=""; prev=""',
      'for a in "$@"; do',
      '  case "$prev" in --output-dir) dir="$a";; --species) sp="$a";; --seed) sd="$a";; esac',
      '  prev="$a"',
      'done',
      // The generator names its own file, which is why the handler has to
      // discover what appeared rather than predict a path.
      writeImage
        ? '[ -n "$dir" ] && printf png > "$dir/$sp-$sd.png"'
        : ': # deliberately writes nothing',
      stderr ? `printf %s ${JSON.stringify(stderr)} >&2` : ':',
      // Last, so the handler has long since had its chance to renice us: this
      // is the scheduler's own answer to "what did that render actually run
      // at", read from inside the process the handler spawned.
      recordNice ? `ps -o nice= -p $$ > ${JSON.stringify(niceLog)} 2>/dev/null || :` : ':',
      `exit ${exitCode}`,
    ].join('\n'),
  );
  await chmod(blender, 0o755);
  return { root, argvLog, niceLog, blender, blenderArgs: [] };
}

/**
 * Points the handler at a fixture for the duration of one test.
 *
 * On Windows the recorder needs node plus a shim argument, which ALPHA_BLENDER
 * alone cannot express — so that branch asserts on buildArgs and the
 * validation rather than on a live run.
 */
function useFixture(t, f) {
  const previous = { ...process.env };
  process.env.ALPHA_RENDER_ROOT = f.root;
  process.env.ALPHA_BLENDER = f.blender;
  delete process.env.ALPHA_RENDER_SCRIPT;
  delete process.env.ALPHA_RENDER_OUTPUT;
  delete process.env.ALPHA_RENDER_SPECIES;
  delete process.env.ALPHA_RENDER_TIMEOUT_MS;
  delete process.env.ALPHA_RENDER_THREADS;
  delete process.env.ALPHA_AGENT_TASK_PRIORITY;
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  });
}

const recordedArgv = async (argvLog) => JSON.parse(await readFile(argvLog, 'utf8'));

// ---------------------------------------------------------------- validation

test('a species must be a well-formed name', () => {
  assert.equal(validateSpecies('fern'), 'fern');
  assert.equal(validateSpecies('tree-fern_2'), 'tree-fern_2');

  for (const bad of ['', 'Fern', '2fern', 'fern fern', 'fern;rm -rf /', '../etc', 'f'.repeat(65)]) {
    assert.throws(() => validateSpecies(bad), /species/, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('a machine may declare which species it generates', (t) => {
  t.after(() => delete process.env.ALPHA_RENDER_SPECIES);
  process.env.ALPHA_RENDER_SPECIES = 'fern, oak ,beetle';

  assert.equal(validateSpecies('oak'), 'oak');
  // Well-formed but not something this machine makes: refused here rather than
  // handed to a generator that would fall back to something else.
  assert.throws(() => validateSpecies('dragon'), /this machine generates fern, oak, beetle/);
});

test('a seed must survive a JSON round trip exactly', () => {
  assert.equal(validateSeed(0), 0);
  assert.equal(validateSeed(1234), 1234);
  assert.equal(validateSeed(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);

  // A recipe is only reproducible if the seed comes back the same number.
  for (const bad of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 2, '1234', null, undefined]) {
    assert.throws(() => validateSeed(bad), /seed/, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('a payload carrying params is refused, not quietly dropped', () => {
  // The generator has no --param flag. Accepting them would return a recipe
  // naming values that had no effect on the image it describes, which is the
  // one thing a recipe must never do.
  assert.equal(rejectUnsupportedParams({ species: 'beetle', seed: 1 }), undefined);
  assert.equal(rejectUnsupportedParams({ species: 'beetle', seed: 1, params: null }), undefined);

  assert.throws(
    () => rejectUnsupportedParams({ species: 'beetle', seed: 1, params: { height: 2 } }),
    /only "species" and "seed"/,
  );
});

// ------------------------------------------------------------------- the argv

test('the argv hands Blender the script and the generator its arguments', () => {
  const args = buildArgs({
    script: '/r/scripts/generate.py',
    species: 'beetle',
    seed: 1234,
    outputDir: '/r/output',
  });

  // The generator's real interface: --species --seed --output-dir, and it
  // names the file itself.
  assert.deepEqual(args, [
    '--background',
    '--factory-startup',
    '--python-exit-code',
    '1',
    '--python',
    '/r/scripts/generate.py',
    '--',
    '--species',
    'beetle',
    '--seed',
    '1234',
    '--output-dir',
    '/r/output',
  ]);

  // Everything the generator reads sits after the bare `--`, or Blender's own
  // parser would consume it.
  assert.ok(args.indexOf('--') < args.indexOf('--species'));
  // --factory-startup is not decoration: a render that depends on this
  // machine's saved preferences is not reproducible from the recipe.
  assert.ok(args.includes('--factory-startup'));
  // Nor is this: verified against Blender 4.0.2 that a script raising on its
  // first line still exits 0 without it, which is the likeliest failure there
  // is and the one the exit-code guard exists to catch.
  assert.deepEqual(
    args.slice(args.indexOf('--python-exit-code'), args.indexOf('--python-exit-code') + 2),
    ['--python-exit-code', '1'],
  );
});

test('another render\'s output is never claimed as this one\'s', async (t) => {
  if (isWindows) return;
  // The hazard the staging directory exists for. An earlier version compared
  // mtimes against the render's start, so a file another task had just written
  // into the shared directory satisfied the "did it produce anything" guard —
  // and got returned under this task's recipe.
  const f = await fixture({ writeImage: false });
  useFixture(t, f);

  // Exactly what a concurrent render would leave behind, written now.
  await writeFile(join(f.root, 'output', 'fern-999.png'), 'someone else');

  await assert.rejects(run({ species: 'beetle', seed: 1234 }), /wrote nothing/);
});

test('a re-run replaces its own output rather than accumulating copies', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  useFixture(t, f);

  const first = await run({ species: 'beetle', seed: 1234 });
  const second = await run({ species: 'beetle', seed: 1234 });

  assert.equal(second.outputs.length, 1);
  assert.equal(second.outputs[0].path, first.outputs[0].path);
  // And no staging directories left lying around.
  const left = (await readdir(join(f.root, 'output'))).filter((n) => n.startsWith('.render-'));
  assert.deepEqual(left, []);
});

test('a render killed mid-flight is a failure, not a silent success', async (t) => {
  if (isWindows) return;
  // Verified against Node: a timeout-killed child reports code null, not a
  // number, so `code ?? 0` read it as a clean exit and the guard never fired.
  const f = await fixture({ writeImage: false });
  useFixture(t, f);
  process.env.ALPHA_RENDER_TIMEOUT_MS = '150';

  // Make the stub outlast its own timeout.
  await writeFile(f.blender, '#!/usr/bin/env bash\nsleep 5\n');
  await chmod(f.blender, 0o755);

  await assert.rejects(run({ species: 'beetle', seed: 1234 }), /killed before it finished/);
});

test('a blank environment variable means unset, not empty', (t) => {
  const f = { root: tmpdir(), blender: 'blender' };
  useFixture(t, f);
  // ALPHA_RENDER_OUTPUT= would otherwise resolve to the render root itself,
  // and every file in it would be reported as this render's output.
  process.env.ALPHA_RENDER_OUTPUT = '   ';
  assert.doesNotThrow(() => buildArgs({ script: 's', species: 'a', seed: 1, outputDir: 'd' }));
});

// ---------------------------------------- not taking the machine over with it

test('the argv caps Blender a core short of the machine', () => {
  const args = buildArgs({
    script: '/r/scripts/generate.py',
    species: 'beetle',
    seed: 1234,
    outputDir: '/r/output',
    threads: 3,
  });

  assert.deepEqual(
    args.slice(args.indexOf('--threads'), args.indexOf('--threads') + 2),
    ['--threads', '3'],
  );
  // Blender reads its own options in order and stops at the bare `--`, so the
  // cap has to be ahead of both --python and the generator's arguments or it
  // would be handed to the script instead of applied.
  assert.ok(args.indexOf('--threads') < args.indexOf('--python'));
  assert.ok(args.indexOf('--threads') < args.indexOf('--'));
});

test('a dedicated render box can hand Blender the whole machine', () => {
  const args = buildArgs({
    script: '/r/scripts/generate.py',
    species: 'beetle',
    seed: 1,
    outputDir: '/r/output',
    threads: 0,
  });

  // Omitted rather than passed as 0. `--threads 0` is Blender's autodetect and
  // would work, but a flag that is not there cannot be misread later as a cap
  // of none.
  assert.ok(!args.includes('--threads'));
});

test('a render runs below the machine\'s own work, on a core less than all of them', async (t) => {
  if (isWindows) return; // see useFixture
  const f = await fixture({ recordNice: true });
  useFixture(t, f);
  process.env.ALPHA_RENDER_THREADS = '2';

  await run({ species: 'beetle', seed: 7 });

  // The cap really reached Blender, through a process boundary.
  const argv = await recordedArgv(f.argvLog);
  assert.deepEqual(
    argv.slice(argv.indexOf('--threads'), argv.indexOf('--threads') + 2),
    ['--threads', '2'],
  );

  // And the process itself really ran nicer than the agent that spawned it.
  // Asked of the scheduler from inside the render, not of the argument we
  // passed: this is the half that keeps a laptop's desktop responsive, and a
  // test that only checked the argv would pass with the renice removed.
  const nice = Number((await readFile(f.niceLog, 'utf8')).trim());
  assert.ok(Number.isFinite(nice), 'the fixture recorded its own nice value');
  assert.ok(nice > os.getPriority(process.pid), `render ran at ${nice}, no nicer than the agent`);
});

test('a machine that cannot read those settings does not offer to render', async (t) => {
  const f = await fixture();
  useFixture(t, f);
  assert.deepEqual(available(), { ok: true });

  // A typo here would otherwise be found at task time — an attempt spent, and
  // a retry free to land on the same machine. Same rule as every other check
  // in available(): ask exactly what run() asks.
  process.env.ALPHA_AGENT_TASK_PRIORITY = 'belownormal';
  assert.equal(available().ok, false);
  assert.match(available().reason, /task priority must be one of/);

  delete process.env.ALPHA_AGENT_TASK_PRIORITY;
  process.env.ALPHA_RENDER_THREADS = 'all';
  assert.equal(available().ok, false);
  assert.match(available().reason, /between 0 and 1024/);
});

// --------------------------------------------------------------- running it

test('a render returns the recipe and leaves the image on the machine', async (t) => {
  if (isWindows) return; // see useFixture
  const f = await fixture();
  useFixture(t, f);

  const result = await run({ species: 'beetle', seed: 1234 });

  // The recipe is the whole payload anyone needs to ask again.
  assert.deepEqual(result.recipe, { species: 'beetle', seed: 1234 });
  // The image did not travel; what landed and how big it is did.
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].name, 'beetle-1234.png');
  assert.equal(result.outputs[0].bytes, 3);
  assert.match(result.outputs[0].path, /output[\\/]beetle-1234\.png$/);
  assert.ok(typeof result.renderedInMs === 'number');

  // And the arguments really reached the generator in the shape buildArgs
  // promises, through a real process boundary.
  const argv = await recordedArgv(f.argvLog);
  assert.ok(argv.includes('--factory-startup'));
  const tail = argv.slice(argv.indexOf('--') + 1);
  assert.deepEqual(tail.slice(0, 4), ['--species', 'beetle', '--seed', '1234']);
  assert.equal(tail[4], '--output-dir');
  // Its own directory, not the shared one: that is what makes the files found
  // afterwards unambiguously this render's.
  assert.match(tail[5], /output[\\/]\.render-/);
});

test('shell metacharacters in a parameter are data, not syntax', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  useFixture(t, f);

  // The species is the only caller-supplied string that reaches the argv, and
  // validateSpecies already refuses anything like this — so the belt-and-braces
  // check is that the output directory, which comes from configuration, also
  // survives intact through execFile rather than being re-parsed by a shell.
  const nasty = "a dir; rm -rf / && echo $(whoami) `id`";
  await mkdir(join(f.root, nasty), { recursive: true });
  process.env.ALPHA_RENDER_OUTPUT = nasty;

  await run({ species: 'beetle', seed: 1 });

  const argv = await recordedArgv(f.argvLog);
  // One argv entry, intact. execFile takes a vector, so there is no shell to
  // reinterpret any of this.
  const dirArg = argv[argv.indexOf('--output-dir') + 1];
  assert.ok(
    dirArg.startsWith(join(f.root, nasty)),
    `the directory arrived as one argument, got ${JSON.stringify(dirArg)}`,
  );
});

test('a generator that fails is a failed task, not a result', async (t) => {
  if (isWindows) return;
  const f = await fixture({ exitCode: 1, stderr: 'no such species', writeImage: false });
  useFixture(t, f);

  // Unlike the coordination tunnel, where a non-zero exit is the script
  // answering "no", a generator that exits non-zero generated nothing.
  await assert.rejects(run({ species: 'beetle', seed: 1 }), /exited 1.*no such species/s);
});

test('a clean exit that produced no image is still a failure', async (t) => {
  if (isWindows) return;
  // The worse case: reported as a success, it would hand back a recipe that
  // reproduces nothing and an image path pointing at nothing.
  const f = await fixture({ exitCode: 0, writeImage: false });
  useFixture(t, f);

  await assert.rejects(run({ species: 'beetle', seed: 1 }), /wrote nothing/);
});

test('the handler refuses to run unconfigured, rather than guessing', async (t) => {
  const previous = process.env.ALPHA_RENDER_ROOT;
  t.after(() => {
    if (previous === undefined) delete process.env.ALPHA_RENDER_ROOT;
    else process.env.ALPHA_RENDER_ROOT = previous;
  });

  delete process.env.ALPHA_RENDER_ROOT;
  await assert.rejects(run({ species: 'beetle', seed: 1 }), /ALPHA_RENDER_ROOT is not set/);

  process.env.ALPHA_RENDER_ROOT = join(tmpdir(), 'alpha-render-does-not-exist');
  await assert.rejects(run({ species: 'beetle', seed: 1 }), /does not exist/);
});

test('a script or output directory outside the root is refused', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  useFixture(t, f);

  process.env.ALPHA_RENDER_SCRIPT = '../escape.py';
  await assert.rejects(run({ species: 'beetle', seed: 1 }), /must live inside ALPHA_RENDER_ROOT/);

  delete process.env.ALPHA_RENDER_SCRIPT;
  process.env.ALPHA_RENDER_OUTPUT = '../elsewhere';
  await assert.rejects(run({ species: 'beetle', seed: 1 }), /must live inside ALPHA_RENDER_ROOT/);
});

// ------------------------------------------- claiming only what it can do

test('a machine with the generator and Blender offers to render', async (t) => {
  const f = await fixture();
  useFixture(t, f);
  assert.deepEqual(available(), { ok: true });
});

test('a machine missing any part of the setup says which part', async (t) => {
  const f = await fixture();
  useFixture(t, f);

  // The likely case, and the reason this exists: `.env.agent` copied from the
  // host to a laptop that has neither the generator nor Blender.
  delete process.env.ALPHA_RENDER_ROOT;
  assert.match(available().reason, /ALPHA_RENDER_ROOT is not set/);
  assert.equal(available().ok, false);

  process.env.ALPHA_RENDER_ROOT = join(tmpdir(), 'alpha-render-does-not-exist');
  assert.match(available().reason, /does not exist/);

  // Root is there, generator is not.
  process.env.ALPHA_RENDER_ROOT = f.root;
  process.env.ALPHA_RENDER_SCRIPT = 'scripts/missing.py';
  assert.match(available().reason, /generator script not found/);
  delete process.env.ALPHA_RENDER_SCRIPT;

  // Everything but the renderer itself.
  process.env.ALPHA_BLENDER = join(f.root, 'no-such-blender');
  assert.match(available().reason, /Blender not found/);
});

test('the check asks the same questions the render will', async (t) => {
  // A configuration this passes and `run()` then rejects would be worse than
  // no check at all: the task would fail after being placed, which is exactly
  // what this is here to prevent.
  const f = await fixture();
  useFixture(t, f);

  process.env.ALPHA_RENDER_OUTPUT = '../escape';
  assert.match(available().reason, /must live inside ALPHA_RENDER_ROOT/);
  await assert.rejects(run({ species: 'beetle', seed: 1 }), /must live inside ALPHA_RENDER_ROOT/);
});

test('Blender on PATH counts, because that is how execFile finds it', async (t) => {
  // The default is the bare name `blender`, which execFile resolves against
  // PATH. A check that only accepted an absolute path would report the host's
  // own GPU machine as unable to render.
  const f = await fixture();
  useFixture(t, f);
  if (isWindows) return;

  process.env.ALPHA_BLENDER = 'blender.sh';
  process.env.PATH = `${f.root}${delimiter}${process.env.PATH}`;
  assert.equal(available().ok, true);

  process.env.PATH = process.env.PATH.replace(`${f.root}${delimiter}`, '');
  assert.equal(available().ok, false);
});

test('a handler that cannot run here is not registered, and says why', async (t) => {
  const f = await fixture();
  useFixture(t, f);
  const registry = new HandlerRegistry([]);

  delete process.env.ALPHA_RENDER_ROOT;
  const refused = registry.add(renderHandler);
  assert.equal(refused.registered, false);
  assert.equal(refused.type, 'alpha.render');
  assert.match(refused.reason, /ALPHA_RENDER_ROOT/);
  assert.equal(registry.has('alpha.render'), false);

  // And the same machine, once it has what it needs.
  process.env.ALPHA_RENDER_ROOT = f.root;
  assert.equal(registry.add(renderHandler).registered, true);
  assert.equal(registry.has('alpha.render'), true);
});

test('a handler with nothing to prove is registered as before', () => {
  // Every built-in: no external program, so no `available()` and no question
  // to ask. Adding the check must not make them conditional on anything.
  const registry = new HandlerRegistry([]);
  const outcome = registry.add({ type: 'echo', run: async () => ({}) });
  assert.equal(outcome.registered, true);
  assert.equal(registry.has('echo'), true);
});

/** Runs the agent entrypoint as a subprocess and collects its output. */
function spawnAgent(env, { waitFor, timeoutMs = 15_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['src/agent/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ALPHA_AGENT_KEY: 'irrelevant-but-present',
        // Port 1 refuses instantly, so the agent never actually attaches — the
        // handler list is decided before it dials out.
        ALPHA_HOST_URL: 'http://127.0.0.1:1',
        ALPHA_LOG_LEVEL: 'info',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const done = () => {
      child.kill('SIGKILL');
      clearTimeout(timer);
      resolvePromise(output);
    };
    const onChunk = (chunk) => {
      output += chunk;
      if (waitFor && output.includes(waitFor)) done();
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('exit', done);
    const timer = setTimeout(done, timeoutMs);
  });
}

test('an agent asked to render without the means says so and lends anyway', async () => {
  // The whole point, end to end: this machine keeps working, it just never
  // claims `alpha.render` for the host to place a render against.
  const output = await spawnAgent(
    { ALPHA_EXTRA_HANDLERS: 'alpha-render', ALPHA_RENDER_ROOT: '' },
    { waitFor: 'starting host=' },
  );

  assert.match(output, /not offering a handler this machine cannot run/);
  assert.match(output, /ALPHA_RENDER_ROOT is not set/);
  // Asserted on the capabilities the agent registers with, which is what the
  // host places against — not on the handler list, whose descriptions mention
  // alpha.render by name for readers.
  const capabilities = /capabilities=(\[[^\]]*\])/.exec(output)?.[1] ?? '';
  assert.ok(capabilities.length > 0, 'the agent should report its capabilities');
  assert.equal(capabilities.includes('alpha.render'), false);
  // Still a working worker for everything else.
  assert.match(capabilities, /echo/);
});

test('an agent that can render offers it', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  const output = await spawnAgent(
    {
      ALPHA_EXTRA_HANDLERS: 'alpha-render',
      ALPHA_RENDER_ROOT: f.root,
      ALPHA_BLENDER: f.blender,
    },
    { waitFor: 'starting host=' },
  );

  assert.match(output, /registered extra handler/);
  const capabilities = /capabilities=(\[[^\]]*\])/.exec(output)?.[1] ?? '';
  assert.match(capabilities, /alpha\.render/);
});
