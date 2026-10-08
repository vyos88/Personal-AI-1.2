// coord-post: one message to Alpha's coordination log, through the handler the
// tunnel already uses. Run against a real PowerShell script standing in for
// Alpha's, so what arrives is what the script would really be given.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeMessage, MAX_POST } from '../scripts/coord-post.mjs';

const PWSH = process.env.PWSH ?? 'pwsh';
const skip = spawnSync(PWSH, ['-NoProfile', '-Command', 'exit 0']).status !== 0 && 'PowerShell is not installed here';
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'coord-post.mjs');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('a message is decoded, tidied and bounded before anything runs', () => {
  assert.equal(decodeMessage(b64('  hello\r\nAlpha \u0007 ')), 'hello\nAlpha');
  assert.throws(() => decodeMessage('not base64!'), /base64/);
  assert.throws(() => decodeMessage(b64('   ')), /empty/);
  assert.throws(() => decodeMessage(b64('x'.repeat(MAX_POST + 1))), /at most/);
});

test('the message reaches Alpha\'s script whole, as one argument, quotes and all', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-root-'));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'alpha_coordination_tunnel.ps1'),
    'param($Action, $Actor, $Message, $Paths)\n"ACTION=$Action"\n"ACTOR=$Actor"\n"MESSAGE=$Message"\n');
  const message = 'Phase 2: the data is on the Host. "quoted" -Actor evil; $(whoami) & done';
  const r = spawnSync(process.execPath, [SCRIPT, '--message-b64', b64(message), '--actor', 'cloud-claude', '--env', join(root, 'none')],
    { encoding: 'utf8', env: { ...process.env, ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: PWSH, ALPHA_COORDINATION_ACTIONS: '' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /posted to Alpha's coordination log as cloud-claude: exit 0/);
  assert.match(r.stdout, /ACTION=Post/);
  assert.match(r.stdout, /ACTOR=cloud-claude/);
  assert.ok(r.stdout.includes(`MESSAGE=${message}`), r.stdout);
});

test('a coordination root that is gone is refused and never created', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'coord-gone-')), 'Alpha-1.8');
  const r = spawnSync(process.execPath, [SCRIPT, '--message-b64', b64('hello'), '--env', join(missing, 'none')],
    { encoding: 'utf8', env: { ...process.env, ALPHA_REPO_ROOT: missing } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /REFUSED: ALPHA_REPO_ROOT does not exist: .*Alpha-1\.8 \(not created/);
  assert.equal(existsSync(missing), false);
});
