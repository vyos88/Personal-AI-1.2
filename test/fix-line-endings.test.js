// Doubled line ends in Alpha's source, repaired without anyone having to.
//
// apply-alpha-update.mjs wrote CR CR LF on Windows until 2026-10-07, and on
// Worker1 that broke every backtick continuation in alpha_agent_manager.ps1.
// The writer is fixed; this is the standing repair the autopilot runs every
// pass. What these tests are about is what it must never do: touch anything
// but CR bytes, touch files outside the trees the updater writes, or lose the
// original.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, onlyCrChanged, repairBytes } from '../scripts/fix-line-endings.mjs';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const DAMAGED_PS1 = Buffer.from('$a = Get-Thing -WorkerId $workerId `\r\r\n    -ReceiptStatus $status\r\r\n');
const REPAIRED_PS1 = Buffer.from('$a = Get-Thing -WorkerId $workerId `\r\n    -ReceiptStatus $status\r\n');

function put(path, buf) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, buf);
}

/** An Alpha install shaped like Worker1's: software\ with the scripts\ folder beside it. */
function alpha() {
  const top = mkdtempSync(join(tmpdir(), 'alpha-eol-'));
  const sw = join(top, 'software');
  put(join(sw, 'frontend', 'package.json'), Buffer.from('{}\r\n'));
  put(join(top, 'scripts', 'alpha_agent_manager.ps1'), Buffer.concat([BOM, DAMAGED_PS1]));
  put(join(top, 'scripts', 'clean.ps1'), Buffer.from('Write-Host ok\r\n'));
  // Latin-1 é in a Windows-1252 file: a decode and re-encode would mangle it.
  put(join(sw, 'backend', 'main.py'), Buffer.from([0x23, 0x20, 0xe9, 0x0d, 0x0d, 0x0a, 0x78, 0x0d, 0x0d, 0x0a]));
  put(join(sw, 'frontend', 'node_modules', 'dep', 'index.js'), Buffer.from('a\r\r\n'));
  put(join(sw, 'backend', 'venv', 'lib', 'x.py'), Buffer.from('a\r\r\n'));
  put(join(sw, 'frontend', 'src', 'logo.png'), Buffer.from('\x89PNG\r\r\n'));
  return { top, sw, ops: join(top, 'ops') };
}

function run(argv, now) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    return { code: main(argv, now), out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

test('a run of CRs before a newline becomes one CRLF, and nothing else moves', () => {
  assert.deepEqual(repairBytes(Buffer.from('a\r\r\nb\r\r\r\nc\r\nd\n')).fixed, Buffer.from('a\r\nb\r\nc\r\nd\n'));
  assert.equal(repairBytes(Buffer.from('a\r\r\nb\r\r\r\n')).count, 2);
  const clean = Buffer.from('a\r\nb\nc\r');
  assert.equal(repairBytes(clean).count, 0);
  assert.equal(repairBytes(clean).fixed, clean);
  assert.equal(onlyCrChanged(DAMAGED_PS1, REPAIRED_PS1), true);
  assert.equal(onlyCrChanged(DAMAGED_PS1, Buffer.from('changed')), false);
});

test('report-only names the damage and changes nothing', () => {
  const a = alpha();
  const before = readFileSync(join(a.top, 'scripts', 'alpha_agent_manager.ps1'));
  const { code, out } = run(['--alpha-root', a.sw, '--ops', a.ops]);
  assert.equal(code, 1);
  assert.match(out, /PROBLEM: scripts.alpha_agent_manager\.ps1 has 2 doubled line end/);
  assert.match(out, /PROBLEM: software.backend.main\.py has 2 doubled line end/);
  assert.doesNotMatch(out, /node_modules|venv|logo\.png/);
  assert.deepEqual(readFileSync(join(a.top, 'scripts', 'alpha_agent_manager.ps1')), before);
  assert.equal(existsSync(join(a.ops, 'backups')), false);
});

test('--fix repairs only CR bytes, keeps BOM and encoding, and backs up the originals', () => {
  const a = alpha();
  const cleanPath = join(a.top, 'scripts', 'clean.ps1');
  const cleanMtime = statSync(cleanPath).mtimeMs;

  const { code, out } = run(['--alpha-root', a.sw, '--ops', a.ops, '--fix']);
  assert.equal(code, 2, out);
  assert.match(out, /FIXED: scripts.alpha_agent_manager\.ps1 \(2 doubled line end/);

  assert.deepEqual(readFileSync(join(a.top, 'scripts', 'alpha_agent_manager.ps1')), Buffer.concat([BOM, REPAIRED_PS1]));
  assert.deepEqual(readFileSync(join(a.sw, 'backend', 'main.py')), Buffer.from([0x23, 0x20, 0xe9, 0x0d, 0x0a, 0x78, 0x0d, 0x0a]));
  // Outside its trees, and not text: left exactly as found.
  assert.deepEqual(readFileSync(join(a.sw, 'frontend', 'node_modules', 'dep', 'index.js')), Buffer.from('a\r\r\n'));
  assert.deepEqual(readFileSync(join(a.sw, 'backend', 'venv', 'lib', 'x.py')), Buffer.from('a\r\r\n'));
  assert.deepEqual(readFileSync(join(a.sw, 'frontend', 'src', 'logo.png')), Buffer.from('\x89PNG\r\r\n'));
  assert.equal(statSync(cleanPath).mtimeMs, cleanMtime, 'a clean file is never rewritten');

  const [backup] = readdirSync(join(a.ops, 'backups'));
  assert.match(backup, /^line-endings-\d{8}-\d{6}$/);
  assert.deepEqual(readFileSync(join(a.ops, 'backups', backup, 'scripts', 'alpha_agent_manager.ps1')), Buffer.concat([BOM, DAMAGED_PS1]));
  assert.ok(!readdirSync(join(a.top, 'scripts')).some((n) => n.includes('.tmp')), 'no temp file left in Alpha\'s tree');

  // Nothing left to do on the next pass.
  const again = run(['--alpha-root', a.sw, '--ops', a.ops, '--fix']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /^OK: no doubled line ends/);
});

test('after a full pass it rechecks only what changed, and sweeps everything once a day', () => {
  const a = alpha();
  const t0 = Date.now();
  assert.equal(run(['--alpha-root', a.sw, '--ops', a.ops, '--fix'], t0).code, 2);

  // Damage an old file without touching its time: a quick pass does not look at it.
  const old = join(a.top, 'scripts', 'clean.ps1');
  writeFileSync(old, 'Write-Host ok\r\r\n');
  const past = new Date(t0 - 3600_000);
  utimesSync(old, past, past);
  const quick = run(['--alpha-root', a.sw, '--ops', a.ops, '--fix'], t0 + 5 * 60_000);
  assert.equal(quick.code, 0, quick.out);
  assert.match(quick.out, /changed file/);

  // A file written since is seen at once. (The test's clock runs ahead of the
  // file system's, so the write is dated inside the simulated window.)
  const fresh = join(a.sw, 'backend', 'new.py');
  writeFileSync(fresh, 'x = 1\r\r\n');
  const written = new Date(t0 + 6 * 60_000);
  utimesSync(fresh, written, written);
  const next = run(['--alpha-root', a.sw, '--ops', a.ops, '--fix'], t0 + 10 * 60_000);
  assert.equal(next.code, 2, next.out);
  assert.match(next.out, /FIXED: software.backend.new\.py/);

  // The daily sweep finds the old one.
  const daily = run(['--alpha-root', a.sw, '--ops', a.ops, '--fix'], t0 + 25 * 3600_000);
  assert.equal(daily.code, 2, daily.out);
  assert.match(daily.out, /FIXED: scripts.clean\.ps1/);
});

test('a machine with no Alpha has nothing to check', () => {
  const empty = mkdtempSync(join(tmpdir(), 'no-alpha-'));
  const { code, out } = run(['--alpha-root', empty, '--fix', '--ops', join(empty, 'ops')]);
  assert.equal(code, 0);
  assert.match(out, /NOTE: no Alpha under/);
});
