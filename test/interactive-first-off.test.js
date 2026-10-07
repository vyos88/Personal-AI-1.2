import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planOff } from '../scripts/interactive-first-off.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'interactive-first-off.mjs');

test('only ALPHA_INTERACTIVE_FIRST_MODE changes, on every line that sets it, line endings kept', () => {
  const text = 'HOST=127.0.0.1\r\nALPHA_INTERACTIVE_FIRST_MODE=true\r\nSECRET=x\r\nALPHA_INTERACTIVE_FIRST_MODE = TRUE\r\nALPHA_LIGHTWEIGHT_AUTONOMY_ENABLED=true\r\n';
  const plan = planOff(text);
  assert.equal(plan.changed, true);
  assert.equal(plan.text, 'HOST=127.0.0.1\r\nALPHA_INTERACTIVE_FIRST_MODE=false\r\nSECRET=x\r\nALPHA_INTERACTIVE_FIRST_MODE=false\r\nALPHA_LIGHTWEIGHT_AUTONOMY_ENABLED=true\r\n');
  assert.equal(plan.before.value, 'true');
  assert.equal(plan.loop.ALPHA_LIGHTWEIGHT_AUTONOMY_ENABLED, 'true');
});

test('a file without the key gets one line appended; one already false is left alone', () => {
  assert.equal(planOff('A=1\n').text, 'A=1\nALPHA_INTERACTIVE_FIRST_MODE=false\n');
  assert.equal(planOff('A=1').text, 'A=1\nALPHA_INTERACTIVE_FIRST_MODE=false\n');
  const off = planOff('ALPHA_INTERACTIVE_FIRST_MODE=false\n');
  assert.equal(off.changed, false);
});

test('the run backs up, writes, prints only the flags, and skips the restart when asked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ifo-'));
  const env = join(dir, '.env.local');
  writeFileSync(env, 'OTHER_SETTING=keep-me\nALPHA_INTERACTIVE_FIRST_MODE=true\nALPHA_LIGHTWEIGHT_AUTONOMY_ENABLED=true\n');
  const r = spawnSync(process.execPath, [SCRIPT, '--env', env, '--no-restart'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /before  : ALPHA_INTERACTIVE_FIRST_MODE=true/);
  assert.match(r.stdout, /after   : ALPHA_INTERACTIVE_FIRST_MODE=false \(backup at/);
  assert.doesNotMatch(r.stdout, /keep-me/);
  assert.match(readFileSync(env, 'utf8'), /^OTHER_SETTING=keep-me\nALPHA_INTERACTIVE_FIRST_MODE=false\n/);
  assert.ok(existsSync(`${env}.bak-interactive-first`));
  assert.match(readFileSync(`${env}.bak-interactive-first`, 'utf8'), /ALPHA_INTERACTIVE_FIRST_MODE=true/);
});

test('no autonomy on is said plainly, and a missing file is a failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ifo-'));
  const env = join(dir, '.env.local');
  writeFileSync(env, 'ALPHA_INTERACTIVE_FIRST_MODE=true\n');
  const r = spawnSync(process.execPath, [SCRIPT, '--env', env, '--no-restart'], { encoding: 'utf8' });
  assert.match(r.stdout, /note    : neither lightweight nor background autonomy is on/);
  const missing = spawnSync(process.execPath, [SCRIPT, '--env', join(dir, 'nope')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /PROBLEM: no settings file/);
});
