import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, findSoftwareRoot, needsPackageInstall } from '../scripts/apply-alpha-update.mjs';

const SUB = 'BuildArtifacts/installers/Alpha-Full/software';
const SCRIPTS = 'BuildArtifacts/installers/Alpha-Full/scripts';
const BASE_STEWARD = ['# steward', '$login = "every 30s"', '$other = 1', ''].join('\n');
const HEAD_STEWARD = BASE_STEWARD.replace('every 30s', 'cached');
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
function fixture({ headMain = HEAD_MAIN, liveScripts = false } = {}) {
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
  write(repo, `${SCRIPTS}/steward.ps1`, BASE_STEWARD);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  write(repo, `${SUB}/backend/main.py`, headMain);
  write(repo, `${SUB}/frontend/src/a.css`, '.a{color:green}\n.b{color:blue}\n');
  write(repo, `${SUB}/frontend/src/fonts.css`, '@font-face{}\n');
  write(repo, 'Models/big.bin', 'changed outside software/\n');
  write(repo, `${SCRIPTS}/steward.ps1`, HEAD_STEWARD);
  write(repo, `${SCRIPTS}/steward_common.ps1`, '# new helper\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'update');

  const live = join(dir, 'live', 'software');
  write(live, 'backend/main.py', BASE_MAIN.replace('return 1', 'return 2  # changed on the host').replace(/\n/g, '\r\n'));
  write(live, 'frontend/package.json', '{"name":"x"}\n');
  write(live, 'frontend/src/a.css', '.a{color:red}\n.b{color:blue}\n');
  if (liveScripts) write(join(dir, 'live'), 'scripts/steward.ps1', BASE_STEWARD.replace(/\n/g, '\r\n'));
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

test('the scripts folder beside software is updated too, and rolled back with it', { skip: !PY && 'no python' }, async () => {
  const f = fixture({ liveScripts: true });
  const scripts = join(f.live, '..', 'scripts');
  const before = readFileSync(join(scripts, 'steward.ps1'), 'utf8');
  const log = quiet();
  assert.equal(await main(args(f, '--apply'), log), 0, log.lines.join('\n'));
  const text = log.lines.join('\n');
  assert.match(text, /applies +M scripts\/steward\.ps1/);
  assert.match(text, /restart them too/);
  const steward = readFileSync(join(scripts, 'steward.ps1'), 'utf8');
  assert.match(steward, /cached/);
  assert.ok(steward.includes('\r\n'), 'keeps CRLF');
  assert.equal(readFileSync(join(scripts, 'steward_common.ps1'), 'utf8'), '# new helper\n');
  const state = JSON.parse(readFileSync(join(f.ops, 'alpha-full-applied.json'), 'utf8'));
  assert.equal(state.scripts_to, state.to);

  const backup = join(f.ops, 'backups', readdirSync(join(f.ops, 'backups'))[0]);
  assert.equal(await main(['--rollback', backup, '--skip-build'], quiet()), 0);
  assert.equal(readFileSync(join(scripts, 'steward.ps1'), 'utf8'), before);
  assert.equal(existsSync(join(scripts, 'steward_common.ps1')), false);
  assert.match(readFileSync(join(f.live, 'backend/main.py'), 'utf8'), /return "old"/);
});

test('without a scripts folder only software is updated', { skip: !PY && 'no python' }, async () => {
  const f = fixture();
  const log = quiet();
  assert.equal(await main(args(f, '--apply'), log), 0, log.lines.join('\n'));
  assert.match(log.lines.join('\n'), /scripts: no .* here, skipped/);
  assert.equal(existsSync(join(f.live, '..', 'scripts')), false, 'no scripts folder is created');
  assert.equal(JSON.parse(readFileSync(join(f.ops, 'alpha-full-applied.json'), 'utf8')).scripts_to, null);
});

test('drifted scripts refuse the update, and --skip-scripts updates software alone', { skip: !PY && 'no python' }, async () => {
  const f = fixture({ liveScripts: true });
  const scripts = join(f.live, '..', 'scripts');
  write(scripts, 'steward.ps1', BASE_STEWARD.replace('every 30s', 'edited on the host'));
  const log = quiet();
  assert.equal(await main(args(f, '--apply'), log), 2);
  assert.match(log.lines.join('\n'), /conflict +M scripts\/steward\.ps1[\s\S]*--skip-scripts/);
  assert.match(readFileSync(join(f.live, 'backend/main.py'), 'utf8'), /return "old"/, 'nothing written');

  const skipped = quiet();
  assert.equal(await main(args(f, '--apply', '--skip-scripts'), skipped), 0, skipped.lines.join('\n'));
  assert.match(readFileSync(join(f.live, 'backend/main.py'), 'utf8'), /return "new"/);
  assert.match(readFileSync(join(scripts, 'steward.ps1'), 'utf8'), /edited on the host/);
  assert.equal(JSON.parse(readFileSync(join(f.ops, 'alpha-full-applied.json'), 'utf8')).scripts_to, null, 'scripts not recorded as applied');
});

const HAS_PWSH = (() => { try { execFileSync('pwsh', ['-NoProfile', '-Command', '1']); return true; } catch { return false; } })();

test('a PowerShell script that no longer parses is put back', { skip: (!PY || !HAS_PWSH) && 'needs python and pwsh' }, async () => {
  const f = fixture({ liveScripts: true });
  const scripts = join(f.live, '..', 'scripts');
  // The live copy already has the change, minus a closing quote: applying the
  // new helper is clean, but the steward check must catch the broken file.
  const repoDir = f.repo.replace('file://', '');
  write(repoDir, `${SCRIPTS}/steward_common.ps1`, 'function x { if ($true) { "unclosed"\n');
  git(repoDir, 'commit', '-qam', 'broken helper');
  const log = quiet();
  assert.equal(await main(args(f, '--apply'), log), 1, log.lines.join('\n'));
  assert.match(log.lines.join('\n'), /steward_common\.ps1 does not parse/);
  assert.equal(existsSync(join(scripts, 'steward_common.ps1')), false);
  assert.match(readFileSync(join(scripts, 'steward.ps1'), 'utf8'), /every 30s/);
});

test('--branch follows a side branch with its own record and never moves alpha-full\'s', { skip: !PY && 'no python' }, async () => {
  const f = fixture();
  assert.equal(await main(args(f, '--apply'), quiet()), 0);
  const fullState = readFileSync(join(f.ops, 'alpha-full-applied.json'), 'utf8');
  const fullTo = JSON.parse(fullState).to;

  // A host branch: what this machine runs, plus one fix on top.
  const repo = f.repo.replace('file://', '');
  git(repo, 'checkout', '-q', '-b', 'alpha-live');
  write(repo, `${SUB}/frontend/src/a.css`, '.a{color:green}\n.b{color:purple}\n');
  git(repo, 'commit', '-qam', 'fix on the host branch');
  git(repo, 'checkout', '-q', 'alpha-full');
  const base = ['--alpha-root', join(f.live, '..'), '--repo', f.repo, '--ops', f.ops, '--skip-build', '--python', PY, '--skip-scripts'];

  const noFrom = quiet();
  assert.equal(await main([...base, '--branch', 'alpha-live', '--apply'], noFrom), 1);
  assert.match(noFrom.lines.join('\n'), /needs --from/);

  const out = quiet();
  assert.equal(await main([...base, '--branch', 'alpha-live', '--from', fullTo, '--apply'], out), 0, out.lines.join('\n'));
  assert.equal(readFileSync(join(f.live, 'frontend/src/a.css'), 'utf8'), '.a{color:green}\n.b{color:purple}\n');
  assert.equal(readFileSync(join(f.ops, 'alpha-full-applied.json'), 'utf8'), fullState, 'alpha-full\'s record is untouched');
  const side = JSON.parse(readFileSync(join(f.ops, 'applied-alpha-live.json'), 'utf8'));
  assert.notEqual(side.to, fullTo);

  // The next run on the side branch starts from its own record: nothing new.
  const again = quiet();
  assert.equal(await main([...base, '--branch', 'alpha-live', '--apply'], again), 0);
  assert.match(again.lines.join('\n'), /nothing new/);
});

test('a branch name that is not one is refused', async () => {
  const f = fixture();
  const out = quiet();
  assert.equal(await main(args(f, '--branch', '../../etc'), out), 1);
  assert.match(out.lines.join('\n'), /not a branch name/);
});

test('packages are reinstalled only when they changed or are missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-npm-'));
  assert.equal(needsPackageInstall(dir, ['frontend/src/a.css']), true, 'no node_modules: install');
  mkdirSync(join(dir, 'node_modules'));
  assert.equal(needsPackageInstall(dir, ['frontend/src/a.css']), false);
  assert.equal(needsPackageInstall(dir, ['frontend/package.json']), true);
  assert.equal(needsPackageInstall(dir, ['frontend/package-lock.json']), true);
});

test('an update that changes no package builds without npm ci, which a running frontend would block', { skip: (!PY || process.platform === 'win32') && 'needs python, not Windows' }, async () => {
  const f = fixture();
  mkdirSync(join(f.live, 'frontend', 'node_modules'));
  const bin = join(f.dir, 'bin');
  mkdirSync(bin);
  const calls = join(f.dir, 'npm-calls.txt');
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$@" >> "${calls}"\nexit 0\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const a = args(f, '--apply').filter((x) => x !== '--skip-build');
    const out = quiet();
    assert.equal(await main(a, out), 0, out.lines.join('\n'));
    assert.match(out.lines.join('\n'), /packages unchanged and installed: building \(no npm ci\)/);
  } finally {
    process.env.PATH = path;
  }
  const lines = readFileSync(calls, 'utf8').trim().split('\n');
  assert.deepEqual(lines, ['run build']);
});
