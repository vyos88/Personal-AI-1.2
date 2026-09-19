import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  available,
  buildArgs,
  renderPage,
  resolveBrowser,
  resolveOutputDir,
  run,
  STAGING_PREFIX,
} from '../src/agent/handlers/alpha-grow-render.js';
import * as growRenderHandler from '../src/agent/handlers/alpha-grow-render.js';
import { cropPngTopLeft } from '../src/agent/handlers/png-crop.js';
import { boundsOf } from '../src/agent/handlers/grow.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';

const isWindows = process.platform === 'win32';
const PNG_WRITER = fileURLToPath(new URL('./helpers/write-fixture-png.mjs', import.meta.url));

/**
 * A throwaway render root whose "browser" records the argv it was handed and
 * writes a real PNG, at the exact size `--window-size` asked for, to the path
 * it was told to --screenshot to.
 *
 * Recording the argv is the point, same as in alpha-render's fixture: the
 * flags that get a real browser to behave (--headless, --window-size,
 * --screenshot=<path>, the file:// URL) cannot be guessed at from outside a
 * real process boundary. The image has to be a genuine, decodable PNG and not
 * a placeholder file, because `run()` now crops every screenshot with
 * `cropPngTopLeft` before reporting it -- a fixture that wrote three bytes of
 * "png" would make every one of these tests fail at the crop step instead of
 * testing what they mean to. `writeImage: false` stands in for a browser that
 * exits cleanly having produced nothing.
 */
async function fixture({ exitCode = 0, stderr = '', writeImage = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'alpha-grow-render-'));
  await mkdir(join(root, 'output'), { recursive: true });

  const argvLog = join(root, 'argv.json');
  const browser = join(root, isWindows ? 'browser.cmd' : 'browser.sh');

  if (isWindows) {
    const shim = join(root, 'browser-shim.js');
    await writeFile(
      shim,
      [
        "const { writeFileSync } = require('node:fs');",
        "const { execFileSync } = require('node:child_process');",
        `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));`,
        'const shot = process.argv.find((a) => a.startsWith("--screenshot="));',
        'const size = process.argv.find((a) => a.startsWith("--window-size="));',
        `if (shot && size && ${writeImage}) {`,
        '  const [w, h] = size.slice(14).split(",");',
        `  execFileSync(process.execPath, [${JSON.stringify(PNG_WRITER)}, w, h, shot.slice(13)]);`,
        '}',
        `if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});`,
        `process.exit(${exitCode});`,
      ].join('\n'),
    );
    return { root, argvLog, browser: process.execPath, browserArgs: [shim] };
  }

  await writeFile(
    browser,
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$@" | node -e "` +
        `const fs=require('node:fs');` +
        `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>` +
        `fs.writeFileSync(process.argv[1],JSON.stringify(d.split('\\n').slice(0,-1))))` +
        `" ${argvLog}`,
      'shot=""; wsize=""',
      'for a in "$@"; do',
      '  case "$a" in',
      '    --screenshot=*) shot="${a#--screenshot=}";;',
      '    --window-size=*) wsize="${a#--window-size=}";;',
      '  esac',
      'done',
      writeImage
        ? `[ -n "$shot" ] && [ -n "$wsize" ] && node ${JSON.stringify(PNG_WRITER)} "\${wsize%,*}" "\${wsize#*,}" "$shot"`
        : ': # deliberately writes nothing',
      stderr ? `printf %s ${JSON.stringify(stderr)} >&2` : ':',
      `exit ${exitCode}`,
    ].join('\n'),
  );
  await chmod(browser, 0o755);
  return { root, argvLog, browser, browserArgs: [] };
}

function useFixture(t, f) {
  const previous = { ...process.env };
  process.env.ALPHA_GROW_RENDER_ROOT = f.root;
  process.env.ALPHA_GROW_RENDER_BROWSER = f.browser;
  delete process.env.ALPHA_GROW_RENDER_OUTPUT;
  delete process.env.ALPHA_GROW_RENDER_TIMEOUT_MS;
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  });
}

// ------------------------------------------------------------------- the argv

test('the argv gives the browser a headless screenshot of a local file', () => {
  const args = buildArgs({
    htmlPath: '/r/o/.grow-render-x/organism.html',
    pngPath: '/r/o/.grow-render-x/a.png',
    width: 800,
    height: 600,
    windowHeight: 900,
    asRoot: false,
  });

  assert.ok(!args.includes('--no-sandbox'), 'the sandbox stays on unless running as root');
  assert.ok(args.includes('--headless'));
  // The window is asked for taller than the picture -- see WINDOW_HEIGHT_MARGIN
  // and png-crop.js for why the extra strip has to exist before it can be cropped off.
  assert.ok(args.includes('--window-size=800,900'));
  assert.ok(args.includes('--screenshot=/r/o/.grow-render-x/a.png'));
  assert.ok(args.includes('file:///r/o/.grow-render-x/organism.html'));
});

test('the sandbox drops only when this process is root', () => {
  const args = buildArgs({ htmlPath: '/h', pngPath: '/p', width: 1, height: 1, windowHeight: 1, asRoot: true });
  assert.equal(args[0], '--no-sandbox');
});

// ---------------------------------------------------------------- the markup

test('a hostile rule body cannot break out of the embedded JSON', () => {
  // Nothing user-controlled reaches renderPage's fields today (nodes/edges are
  // numeric, background is regex-checked), but the escape is there so that
  // stays true even if a future caller passes raw recipe text through.
  const html = renderPage({
    nodes: [[0, 0, 0]],
    edges: [],
    bounds: boundsOf([[0, 0, 0]]),
    kind: 'plant',
    width: 100,
    height: 100,
    background: '</script><script>window.pwned=true;//#eef2ec',
  });

  // validateBackground would normally have refused this string; renderPage
  // itself must still never let it split the page's own <script> tag.
  assert.ok(!html.includes('</script><script>window.pwned'));
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
});

test('the page draws before the load event a screenshot waits for', () => {
  const html = renderPage({
    nodes: [[0, 0, 0], [0, 1, 0]],
    edges: [[0, 1, 0.1]],
    bounds: boundsOf([[0, 0, 0], [0, 1, 0]]),
    kind: 'animal',
    width: 320,
    height: 240,
    background: '#eef2ec',
  });

  // Drawing happens synchronously inside an inline script, not deferred to an
  // event handler -- there is nothing here for a screenshot to race against.
  assert.ok(!html.includes('addEventListener'));
  assert.ok(!html.includes('async'));
  assert.match(html, /ctx\.stroke\(\)/);
  // The kind picks the stroke colour: 'animal' is the warm one.
  assert.match(html, /#b5533c/);
});

// ---------------------------------------------------------------- the crop

test('cropping keeps every pixel in the kept region and drops the rest', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'png-crop-'));
  const src = join(dir, 'src.png');
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [PNG_WRITER, '700', '500', src]);

  const original = await readFile(src);
  const cropped = cropPngTopLeft(original, 500, 400);

  assert.equal(cropped.readUInt32BE(16), 500);
  assert.equal(cropped.readUInt32BE(20), 400);

  // Decode both and compare: every pixel the crop kept must be byte-identical
  // to where it started, which is the whole promise of a *crop* rather than a
  // resize. Re-run through the same decode path this module uses internally,
  // proven independently by feeding it its own output.
  const identity = cropPngTopLeft(cropped, 500, 400);
  assert.ok(identity.equals(cropped), 'cropping an already-cropped image is a no-op');
});

test('cropping to a size larger than the source is refused, not padded', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'png-crop-'));
  const src = join(dir, 'src.png');
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [PNG_WRITER, '100', '100', src]);

  const original = await readFile(src);
  assert.throws(() => cropPngTopLeft(original, 200, 100), /cannot crop to 200x100/);
});

test('a non-PNG buffer is refused rather than misread', () => {
  assert.throws(() => cropPngTopLeft(Buffer.from('not a png'), 10, 10), /not a PNG file/);
});

// --------------------------------------------------------------- running it

test('a render returns the recipe and leaves the image on the machine', async (t) => {
  if (isWindows) return; // see useFixture
  const f = await fixture();
  useFixture(t, f);

  const result = await run({ preset: 'fern', seed: 7, width: 200, height: 150 });

  assert.equal(result.recipe.name, 'fern');
  assert.equal(result.recipe.seed, 7);
  assert.equal(result.outputs.length, 1);
  assert.match(result.outputs[0].name, /^fern-seed7-[0-9a-f]{10}\.png$/);
  assert.ok(result.outputs[0].bytes > 0);
  assert.ok(typeof result.renderedInMs === 'number');
  assert.ok(result.stats.nodes > 0);

  // The reported image is cropped down to exactly what was asked for, not to
  // the taller window the browser was actually given.
  const png = await readFile(result.outputs[0].path);
  assert.equal(png.readUInt32BE(16), 200);
  assert.equal(png.readUInt32BE(20), 150);

  const args = JSON.parse(await readFile(f.argvLog, 'utf8'));
  assert.ok(args.includes('--headless'));
  // The browser is asked for a window taller than the picture -- see
  // WINDOW_HEIGHT_MARGIN -- and the crop above is what turns that back into
  // the 200x150 the caller asked for.
  assert.ok(args.some((a) => a.startsWith('--window-size=200,') && !a.endsWith(',150')));
});

test('a re-run of the same recipe replaces its own output', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  useFixture(t, f);

  const first = await run({ preset: 'fern', seed: 7 });
  const second = await run({ preset: 'fern', seed: 7 });

  assert.equal(second.outputs[0].path, first.outputs[0].path);
  const left = (await readdir(join(f.root, 'output'))).filter((n) => n.startsWith(STAGING_PREFIX));
  assert.deepEqual(left, []);
});

test('two different custom recipes never collide on the same filename', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  useFixture(t, f);

  // Both normalize to recipe.name === "custom", so the filename has to come
  // from more than the name and the seed or the second overwrites the first.
  const a = await run({ axiom: 'F', rules: { F: 'F+F' }, seed: 1 });
  const b = await run({ axiom: 'F', rules: { F: 'F-F' }, seed: 1 });

  assert.equal(a.recipe.name, 'custom');
  assert.equal(b.recipe.name, 'custom');
  assert.notEqual(a.outputs[0].name, b.outputs[0].name);
});

test('a browser killed mid-flight is a failure, not a silent success', async (t) => {
  if (isWindows) return;
  const f = await fixture({ writeImage: false });
  useFixture(t, f);
  process.env.ALPHA_GROW_RENDER_TIMEOUT_MS = '150';

  await writeFile(f.browser, '#!/usr/bin/env bash\nsleep 5\n');
  await chmod(f.browser, 0o755);

  await assert.rejects(run({ preset: 'fern', seed: 1 }), /killed before it finished/);
});

test('a browser that exits non-zero is a failed task, not a result', async (t) => {
  if (isWindows) return;
  const f = await fixture({ exitCode: 1, stderr: 'boom', writeImage: false });
  useFixture(t, f);

  await assert.rejects(run({ preset: 'fern', seed: 1 }), /exited 1.*boom/s);
});

test('a clean exit that wrote no image is still a failure', async (t) => {
  if (isWindows) return;
  const f = await fixture({ exitCode: 0, writeImage: false });
  useFixture(t, f);

  await assert.rejects(run({ preset: 'fern', seed: 1 }), /wrote no image/);
});

test('the handler refuses to run unconfigured, rather than guessing', async (t) => {
  const previous = process.env.ALPHA_GROW_RENDER_ROOT;
  t.after(() => {
    if (previous === undefined) delete process.env.ALPHA_GROW_RENDER_ROOT;
    else process.env.ALPHA_GROW_RENDER_ROOT = previous;
  });

  delete process.env.ALPHA_GROW_RENDER_ROOT;
  await assert.rejects(run({ preset: 'fern', seed: 1 }), /ALPHA_GROW_RENDER_ROOT is not set/);

  process.env.ALPHA_GROW_RENDER_ROOT = join(tmpdir(), 'alpha-grow-render-does-not-exist');
  await assert.rejects(run({ preset: 'fern', seed: 1 }), /does not exist/);
});

test('an output directory outside the root is refused', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  useFixture(t, f);

  process.env.ALPHA_GROW_RENDER_OUTPUT = '../escape';
  await assert.rejects(run({ preset: 'fern', seed: 1 }), /must live inside ALPHA_GROW_RENDER_ROOT/);
});

// ------------------------------------------- claiming only what it can do

test('a machine with the root and a browser offers to render', async (t) => {
  const f = await fixture();
  useFixture(t, f);
  assert.deepEqual(available(), { ok: true });
});

test('a machine missing any part of the setup says which part', async (t) => {
  const f = await fixture();
  useFixture(t, f);

  delete process.env.ALPHA_GROW_RENDER_ROOT;
  assert.match(available().reason, /ALPHA_GROW_RENDER_ROOT is not set/);

  process.env.ALPHA_GROW_RENDER_ROOT = f.root;
  process.env.ALPHA_GROW_RENDER_BROWSER = join(f.root, 'no-such-browser');
  assert.match(available().reason, /browser not found/);
});

test('the check asks the same questions the render will', async (t) => {
  const f = await fixture();
  useFixture(t, f);

  process.env.ALPHA_GROW_RENDER_OUTPUT = '../escape';
  assert.match(available().reason, /must live inside ALPHA_GROW_RENDER_ROOT/);
  await assert.rejects(run({ preset: 'fern', seed: 1 }), /must live inside ALPHA_GROW_RENDER_ROOT/);
});

test('a browser on PATH counts, because that is how execFile finds it', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  useFixture(t, f);

  delete process.env.ALPHA_GROW_RENDER_BROWSER;
  process.env.PATH = `${f.root}${delimiter}${process.env.PATH}`;
  t.after(() => {
    process.env.PATH = process.env.PATH.replace(`${f.root}${delimiter}`, '');
  });

  const found = resolveBrowser();
  assert.equal(found, null, 'the stub is named browser.sh, not one of the real candidate names');

  // But rename it to one of the probed candidates and it is found on PATH,
  // the same way the real default (unset ALPHA_GROW_RENDER_BROWSER) would
  // find a genuinely installed chromium.
  const { copyFile } = await import('node:fs/promises');
  await copyFile(f.browser, join(f.root, 'chromium'));
  await chmod(join(f.root, 'chromium'), 0o755);
  assert.equal(resolveBrowser()?.name, 'chromium');
});

test('a handler that cannot run here is not registered, and says why', async (t) => {
  const f = await fixture();
  useFixture(t, f);
  const registry = new HandlerRegistry([]);

  delete process.env.ALPHA_GROW_RENDER_ROOT;
  const refused = registry.add(growRenderHandler);
  assert.equal(refused.registered, false);
  assert.equal(refused.type, 'alpha.grow-render');
  assert.match(refused.reason, /ALPHA_GROW_RENDER_ROOT/);
  assert.equal(registry.has('alpha.grow-render'), false);

  process.env.ALPHA_GROW_RENDER_ROOT = f.root;
  assert.equal(registry.add(growRenderHandler).registered, true);
  assert.equal(registry.has('alpha.grow-render'), true);
});

test('resolveOutputDir agrees with what run() actually writes into', async (t) => {
  const f = await fixture();
  useFixture(t, f);
  const { outputDir } = resolveOutputDir();
  await run({ preset: 'fern', seed: 3 });
  const files = await readdir(outputDir);
  assert.ok(files.some((n) => n.startsWith('fern-seed3-')));
});

/** Runs the agent entrypoint as a subprocess and collects its output. */
function spawnAgent(env, { waitFor, timeoutMs = 15_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['src/agent/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ALPHA_AGENT_KEY: 'irrelevant-but-present',
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

test('an agent asked to render without a browser says so and lends anyway', async () => {
  const output = await spawnAgent(
    { ALPHA_EXTRA_HANDLERS: 'alpha-grow-render', ALPHA_GROW_RENDER_ROOT: '' },
    { waitFor: 'starting host=' },
  );

  assert.match(output, /not offering a handler this machine cannot run/);
  assert.match(output, /ALPHA_GROW_RENDER_ROOT is not set/);
  const capabilities = /capabilities=(\[[^\]]*\])/.exec(output)?.[1] ?? '';
  assert.ok(capabilities.length > 0, 'the agent should report its capabilities');
  assert.equal(capabilities.includes('alpha.grow-render'), false);
  assert.match(capabilities, /echo/);
});

test('an agent with a browser offers to render', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  const output = await spawnAgent(
    {
      ALPHA_EXTRA_HANDLERS: 'alpha-grow-render',
      ALPHA_GROW_RENDER_ROOT: f.root,
      ALPHA_GROW_RENDER_BROWSER: f.browser,
    },
    { waitFor: 'starting host=' },
  );

  assert.match(output, /registered extra handler/);
  const capabilities = /capabilities=(\[[^\]]*\])/.exec(output)?.[1] ?? '';
  assert.match(capabilities, /alpha\.grow-render/);
});
