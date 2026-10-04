import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, findSoftwareRoot } from '../scripts/apply-alpha-update.mjs';

const SUB = 'BuildArtifacts/installers/Alpha-Full/software';
const PY = (() => {
  for (const name of ['python3', 'python']) {
    try { execFileSync(name, ['--version']); return name; } catch { /* next */ }
  }
  return null;
})();

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function write(root, rel, text) {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const BASE_MAIN = ['import os', '', 'def login():', '    return "old"', '', '', 'def other():', '    return 1', ''].join('\n');
const HEAD_MAIN = BASE_MAIN.replace('return "old"', 'return "new"');

/**
 * A stand-in for vyos88/Alpha: alpha-full at a base commit, then one commit
 * changing a backend file, changing a stylesheet and adding a new one. And a
 * live copy taken from the base that has drifted since: CRLF line endings and
 * an unrelated edit in the same file the update touches.
 */
function fixture({ headMain = HEAD_MAIN } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-update-test-'));
  const repo = join(dir, 'alpha');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'alpha-full');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  write(repo, `${SUB}/backend/main.py`, BASE_MAIN);
  write(repo, `${SUB}/frontend/package.json`, '{"name":"x"}\n');
  write(repo, `${SUB}/frontend/src/a.css`, '.a{color:red}\n.b{color:blue}\n');
  write(repo, 'Models/big.bin', 'not under software/, never applied\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  write(repo, `${SUB}/backend/main.py`, headMain);
  write(repo, `${SUB}/frontend/src/a.css`, '.a{color:green}\n.b{color:blue}\n');
  write(repo, `${SUB}/frontend/src/fonts.css`, '@font-face{}\n');
  write(repo, 'Models/big.bin', 'changed outside software/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'update');

  const live = join(dir, 'live', 'software');
  write(live, 'backend/main.py', BASE_MAIN.replace('return 1', 'return 2  # changed on the host').replace(/\n/g, '\r\n'));
  write(live, 'frontend/package.json', '{"name":"x"}\n');
  write(live, 'frontend/src/a.css', '.a{color:red}\n.b{color:blue}\n');
  return { dir, repo: `file://${repo}`, base, live, ops: join(dir, 'ops') };
}

const quiet = () => {
  const lines = [];
  return Object.assign((l) => lines.push(l), { lines });
};

const args = (f, ...more) => [
  '--alpha-root', join(f.live, '..'), '--repo', f.repo, '--from', f.base, '--ops', f.ops,
  '--skip-build', ...(PY ? ['--python', PY] : []), ...more,
];

test('the software folder is found from the folder above it', () => {
  const f = fixture();
  assert.equal(findSoftwareRoot(join(f.live, '..')), f.live);
  assert.equal(findSoftwareRoot(f.dir), null);
});

test('without --apply it reports and writes nothing', async () => {
  const f = fixture();
  const before = readFileSync(join(f.live, 'backend/main.py'), 'utf8');
  const log = quiet();
  assert.equal(await main(args(f), log), 0);
  assert.match(log.lines.join('\n'), /READY: 3 file\(s\) would change/);
  assert.equal(readFileSync(join(f.live, 'backend/main.py'), 'utf8'), before);
  assert.equal(existsSync(join(f.live, 'frontend/src/fonts.css')), false);
});

test('--apply changes only the edited lines, and keeps CRLF and local edits', { skip: !PY && 'no python' }, async () => {
  const f = fixture();
  const log = quiet();
  assert.equal(await main(args(f, '--apply'), log), 0, log.lines.join('\n'));
  const mainPy = readFileSync(join(f.live, 'backend/main.py'), 'utf8');
  assert.match(mainPy, /return "new"/);
  assert.match(mainPy, /return 2 {2}# changed on the host/, 'the unrelated local edit survives');
  assert.ok(mainPy.includes('\r\n') && !/[^\r]\n/.test(mainPy), 'still CRLF throughout');
  assert.equal(readFileSync(join(f.live, 'frontend/src/a.css'), 'utf8'), '.a{color:green}\n.b{color:blue}\n');
  assert.equal(readFileSync(join(f.live, 'frontend/src/fonts.css'), 'utf8'), '@font-face{}\n');
  assert.equal(existsSync(join(f.live, 'Models')), false, 'nothing outside software/ is applied');
  assert.ok(existsSync(join(f.ops, 'alpha-full-applied.json')));
  assert.equal(readdirSync(join(f.ops, 'backups')).length, 1);
});

test('a second run finds nothing new, because it starts from what it applied', { skip: !PY && 'no python' }, async () => {
  const f = fixture();
  assert.equal(await main(args(f, '--apply'), quiet()), 0);
  const log = quiet();
  // No --from: the recorded commit is the starting point.
  const again = args(f).filter((a, i, all) => a !== '--from' && all[i - 1] !== '--from');
  assert.equal(await main(again, log), 0);
  assert.match(log.lines.join('\n'), /nothing new on alpha-full/);
});

test('a file edited where the change was made refuses the whole update', async () => {
  const f = fixture();
  write(f.live, 'backend/main.py', BASE_MAIN.replace('return "old"', 'return "edited here"'));
  const cssBefore = readFileSync(join(f.live, 'frontend/src/a.css'), 'utf8');
  const log = quiet();
  assert.equal(await main(args(f, '--apply'), log), 2);
  assert.match(log.lines.join('\n'), /conflict +M backend\/main\.py/);
  assert.equal(readFileSync(join(f.live, 'frontend/src/a.css'), 'utf8'), cssBefore, 'not even the clean files');
  assert.equal(existsSync(join(f.live, 'frontend/src/fonts.css')), false);
});

test('an update that leaves Python unparseable is put back on the spot', { skip: !PY && 'no python' }, async () => {
  const f = fixture({ headMain: HEAD_MAIN.replace('return "new"', 'return "new"(') });
  const before = readFileSync(join(f.live, 'backend/main.py'), 'utf8');
  const log = quiet();
  assert.equal(await main(args(f, '--apply'), log), 1);
  assert.match(log.lines.join('\n'), /does not parse/);
  assert.equal(readFileSync(join(f.live, 'backend/main.py'), 'utf8'), before);
  assert.equal(existsSync(join(f.live, 'frontend/src/fonts.css')), false, 'the added file is removed again');
  assert.equal(existsSync(join(f.ops, 'alpha-full-applied.json')), false, 'nothing recorded as applied');
});

test('--rollback restores the files and removes the added ones', { skip: !PY && 'no python' }, async () => {
  const f = fixture();
  const before = readFileSync(join(f.live, 'backend/main.py'), 'utf8');
  assert.equal(await main(args(f, '--apply'), quiet()), 0);
  const backup = join(f.ops, 'backups', readdirSync(join(f.ops, 'backups'))[0]);
  assert.equal(await main(['--rollback', backup, '--skip-build'], quiet()), 0);
  assert.equal(readFileSync(join(f.live, 'backend/main.py'), 'utf8'), before);
  assert.equal(existsSync(join(f.live, 'frontend/src/fonts.css')), false);
});

test('an unreachable repository stops with what to do, and writes nothing', async () => {
  const f = fixture();
  const log = quiet();
  const bad = args(f).map((a) => (a === f.repo ? `file://${join(f.dir, 'nope')}` : a));
  assert.equal(await main(bad, log), 1);
  assert.match(log.lines.join('\n'), /could not fetch alpha-full[\s\S]*credentials/);
});
