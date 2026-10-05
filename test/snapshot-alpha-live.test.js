import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, inRepoShape, scanAddedLines } from '../scripts/snapshot-alpha-live.mjs';

const BASE = 'BuildArtifacts/installers/Alpha-Full';
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });

function write(root, rel, text) {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const quiet = () => {
  const lines = [];
  return Object.assign((l) => lines.push(l), { lines });
};

/**
 * alpha-full with a backend file, a frontend file, a steward script and a file
 * outside software/ and scripts/; and a live copy where the backend file was
 * edited (with CRLF endings), the frontend file only differs by CRLF, the
 * steward is unchanged, and an extra file exists that alpha-full never had.
 */
function fixture({ liveMain = 'def login():\r\n    return "live"\r\n' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-snapshot-test-'));
  const repo = join(dir, 'alpha');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'alpha-full');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  write(repo, `${BASE}/software/backend/main.py`, 'def login():\n    return "old"\n');
  write(repo, `${BASE}/software/frontend/package.json`, '{"name":"x"}\n');
  write(repo, `${BASE}/software/frontend/src/a.css`, '.a{color:red}\n');
  write(repo, `${BASE}/scripts/steward.ps1`, '# steward\n');
  write(repo, 'Models/big.bin', 'never part of a snapshot\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  // A bare copy to push to, so the test can see what arrived.
  const remote = join(dir, 'remote.git');
  git(dir, 'clone', '-q', '--bare', repo, remote);

  const live = join(dir, 'live');
  write(live, 'software/backend/main.py', liveMain);
  write(live, 'software/frontend/package.json', '{"name":"x"}\n');
  write(live, 'software/frontend/src/a.css', '.a{color:red}\r\n');
  write(live, 'scripts/steward.ps1', '# steward\n');
  write(live, 'software/backend/memory/local/alpha-local-service.credential.xml', '<Objs/>');
  return { dir, remote: `file://${remote}`, live, ops: join(dir, 'ops') };
}

const args = (f, ...more) => ['--alpha-root', f.live, '--repo', f.remote, '--ops', f.ops, ...more];

test('a report shows only real content changes and pushes nothing', async () => {
  const f = fixture();
  const log = quiet();
  assert.equal(await main(args(f), log), 0, log.lines.join('\n'));
  const text = log.lines.join('\n');
  assert.match(text, /4 file\(s\) tracked .*; 1 differ here/);
  assert.match(text, /backend\/main\.py/);
  assert.doesNotMatch(text, /a\.css/, 'a line-ending-only difference is not a change');
  assert.match(text, /READY: 1 file/);
  assert.equal(git(f.remote.replace('file://', ''), 'branch', '--list', 'alpha-from-host*').trim(), '');
});

test('--push puts only tracked files on a new branch, never a new file', async () => {
  const f = fixture();
  const log = quiet();
  assert.equal(await main(args(f, '--push', '--branch', 'alpha-from-host-test'), log), 0, log.lines.join('\n'));
  const bare = f.remote.replace('file://', '');
  const files = git(bare, 'diff', '--name-only', 'alpha-full', 'alpha-from-host-test').trim().split('\n');
  assert.deepEqual(files, [`${BASE}/software/backend/main.py`]);
  const pushed = git(bare, 'show', `alpha-from-host-test:${BASE}/software/backend/main.py`);
  assert.equal(pushed, 'def login():\n    return "live"\n', 'stored with the repository\'s LF endings');
  assert.equal(git(bare, 'ls-tree', '-r', '--name-only', 'alpha-from-host-test').includes('credential.xml'), false);
  assert.equal(git(bare, 'rev-parse', 'alpha-full').trim(), git(bare, 'rev-parse', 'alpha-from-host-test~1').trim());
});

test('a credential-looking line added on this machine stops the push', async () => {
  const f = fixture({ liveMain: 'def login():\n    return "old"\nAPI_TOKEN = "abcdefghijklmnopqrstuvwxyz123456"\n' });
  const log = quiet();
  assert.equal(await main(args(f, '--push'), log), 2);
  const text = log.lines.join('\n');
  assert.match(text, /software\/backend\/main\.py:3 +credential-looking/);
  assert.doesNotMatch(text, /abcdefghijklmnop/, 'the value is never printed');
  assert.equal(git(f.remote.replace('file://', ''), 'branch', '--list', 'alpha-from-host*').trim(), '');
});

test('repository shape: BOM and line endings follow the repository copy', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const out = inRepoShape(Buffer.from('a\r\nb\r\n'), Buffer.concat([bom, Buffer.from('x\n')]));
  assert.deepEqual(out, Buffer.concat([bom, Buffer.from('a\nb\n')]));
  assert.deepEqual(inRepoShape(Buffer.from('a\nb\n'), Buffer.from('x\r\n')), Buffer.from('a\r\nb\r\n'));
});

test('added-line scan reports the new file line number', () => {
  const diff = ['+++ b/x.py', '@@ -3,0 +4,2 @@', '+ok = 1', '+SECRET_KEY = "0123456789abcdef0123"'].join('\n');
  assert.deepEqual(scanAddedLines(diff).map((f) => [f.file, f.line]), [['x.py', 5]]);
});

test('findings print the line with long values cut, and --allow clears exactly those lines', async () => {
  const f = fixture({ liveMain: 'def login():\n    return "old"\nAPI_TOKEN = "abcdefghijklmnopqrstuvwxyz123456"\n' });
  const log = quiet();
  assert.equal(await main(args(f, '--push'), log), 2);
  const text = log.lines.join('\n');
  assert.match(text, /API_TOKEN = "abcd…\(32\)"/);
  assert.doesNotMatch(text, /efghij/);
  assert.match(text, /--allow software\/backend\/main\.py:3/);

  const wrong = quiet();
  assert.equal(await main(args(f, '--push', '--allow', 'software/backend/main.py:2'), wrong), 2, 'another line does not clear it');

  const ok = quiet();
  assert.equal(await main(args(f, '--push', '--branch', 'alpha-from-host-allowed', '--allow', 'software/backend/main.py:3'), ok), 0, ok.lines.join('\n'));
  assert.match(ok.lines.join('\n'), /1 credential-looking line\(s\), every one cleared/);
});

test('masking keeps names readable and cuts token-shaped values, quoted or not', async () => {
  const { maskLine } = await import('../scripts/snapshot-alpha-live.mjs');
  assert.equal(maskLine("const CHAT_DOCK_MODE_KEY = 'alphaChatDockModeV2';"), "const CHAT_DOCK_MODE_KEY = 'alph…(19)';");
  assert.equal(maskLine('TOKEN=alpha_agent_ab12cd34.Zx9_long-secret-part-here'), 'TOKEN=alph…(46)');
});
