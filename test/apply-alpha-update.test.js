import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, findSoftwareRoot, nearestHunk, needsPackageInstall, readLive, writeLive } from '../scripts/apply-alpha-update.mjs';

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
  assert.match(log.lines.join('\n'), /main\.py does not parse: line 4: .*\(inside change #1 at lines \d+-\d+\)/);
  assert.doesNotMatch(log.lines.join('\n'), /return "new"/, 'the report names the line, never its text');
  const kept = /the merged file is kept at (.+)$/m.exec(log.lines.join('\n'))?.[1];
  assert.ok(kept && readFileSync(kept, 'utf8').includes('return "new"('), 'the broken merge is kept for whoever fixes it');
  assert.equal(readFileSync(join(f.live, 'backend/main.py'), 'utf8'), before);
  assert.equal(existsSync(join(f.live, 'frontend/src/fonts.css')), false, 'the added file is removed again');
  assert.equal(existsSync(join(f.ops, 'alpha-full-applied.json')), false, 'nothing recorded as applied');
});

// Worker1 job 38: `py` was older than the Python Alpha's backend runs, and
// could not read the live main.py at all (a line 2300 lines from any change).
// The merge is judged by a Python that reads the file as it was.
test('a Python too old for the live file is passed over for one that reads it', { skip: (!PY || process.platform === 'win32') && 'needs python, not Windows' }, async () => {
  const f = fixture();
  write(f.live, 'backend/main.py', `${readFileSync(join(f.live, 'backend/main.py'), 'utf8')}\r\n# needs-newer-python\r\n`);
  const old = join(f.dir, 'old-python');
  writeFileSync(old, `#!/bin/sh\nfor a; do last=$a; done\nif [ -f "$last" ] && grep -q needs-newer-python "$last"; then echo "line 12: invalid syntax" >&2; exit 1; fi\nexec ${PY} "$@"\n`, { mode: 0o755 });
  const log = quiet();
  const code = await main(['--alpha-root', join(f.live, '..'), '--repo', f.repo, '--from', f.base, '--ops', f.ops, '--skip-build', '--python', old, '--apply'], log);
  assert.equal(code, 0, log.lines.join('\n'));
  assert.match(readFileSync(join(f.live, 'backend/main.py'), 'utf8'), /return "new"/);
  assert.match(log.lines.join('\n'), /ok: 1 Python file\(s\) parse/);
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

test('a file a changed script imports, which this machine never had, is brought whole', async () => {
  // Worker1, 2026-10-06: the host branch held frontend/musicBridge.js (from
  // alpha-full; the host never had it), the update changed vite.config.js to
  // import it, and the build failed on "Could not resolve './musicBridge.js'".
  const dir = mkdtempSync(join(tmpdir(), 'alpha-update-imports-'));
  const repo = join(dir, 'alpha');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'alpha-full');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  const CONFIG = "import { defineConfig } from 'vite'\nexport default defineConfig({})\n";
  write(repo, `${SUB}/backend/main.py`, BASE_MAIN);
  write(repo, `${SUB}/frontend/package.json`, '{"name":"x"}\n');
  write(repo, `${SUB}/frontend/vite.config.js`, CONFIG);
  write(repo, `${SUB}/frontend/musicBridge.js`, "import { PORT } from './bridgeDefaults.js'\nexport const target = PORT\n");
  write(repo, `${SUB}/frontend/bridgeDefaults.js`, 'export const PORT = 8790\n');
  write(repo, `${SUB}/frontend/src/here.js`, 'export const here = 1\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  write(repo, `${SUB}/frontend/vite.config.js`, [
    "import { defineConfig } from 'vite'",
    "import { target } from './musicBridge.js'",
    "import { here } from './src/here'",
    "// import { gone } from './nowhere.js'",
    'export default defineConfig({ target, here })',
    '',
  ].join('\n'));
  git(repo, 'commit', '-qam', 'route /music to the bridge');

  const live = join(dir, 'live', 'software');
  write(live, 'backend/main.py', BASE_MAIN);
  write(live, 'frontend/package.json', '{"name":"x"}\n');
  write(live, 'frontend/vite.config.js', CONFIG);
  write(live, 'frontend/src/here.js', 'export const here = 1 // edited here\n');
  const ops = join(dir, 'ops');
  const opts = ['--alpha-root', join(live, '..'), '--repo', `file://${repo}`, '--from', base, '--ops', ops, '--skip-build'];

  const report = quiet();
  assert.equal(await main(opts, report), 0);
  const text = report.lines.join('\n');
  assert.match(text, /applies +A frontend\/musicBridge\.js +\(imported by frontend\/vite\.config\.js; never on this machine\)/);
  assert.match(text, /applies +A frontend\/bridgeDefaults\.js +\(imported by frontend\/musicBridge\.js; never on this machine\)/);
  assert.doesNotMatch(text, /src\/here\.js/, 'a file this machine has is left as it is');
  assert.doesNotMatch(text, /nowhere/, 'a file the branch does not hold cannot be brought');
  assert.match(text, /READY: 3 file\(s\) would change/);
  assert.equal(existsSync(join(live, 'frontend/musicBridge.js')), false, 'a report writes nothing');

  assert.equal(await main([...opts, '--apply'], quiet()), 0);
  assert.equal(readFileSync(join(live, 'frontend/musicBridge.js'), 'utf8'), "import { PORT } from './bridgeDefaults.js'\nexport const target = PORT\n");
  assert.equal(readFileSync(join(live, 'frontend/bridgeDefaults.js'), 'utf8'), 'export const PORT = 8790\n');
  assert.equal(readFileSync(join(live, 'frontend/src/here.js'), 'utf8'), 'export const here = 1 // edited here\n');

  const backup = join(ops, 'backups', readdirSync(join(ops, 'backups'))[0]);
  assert.equal(await main(['--rollback', backup, '--skip-build'], quiet()), 0);
  assert.equal(existsSync(join(live, 'frontend/musicBridge.js')), false, 'rolled back with the change that needed it');
  assert.equal(existsSync(join(live, 'frontend/bridgeDefaults.js')), false);
  assert.equal(readFileSync(join(live, 'frontend/vite.config.js'), 'utf8'), CONFIG);
});

test('a renamed file this machine never had is a delete already done plus a new file', { skip: !PY && 'no python' }, async () => {
  const f = fixture();
  const repo = f.repo.slice('file://'.length);
  const body = ['def test_probe():', '    assert True', '', '', 'def test_more():', '    assert 1', ''].join('\n');
  write(repo, `${SUB}/backend/tests/test_probe.py`, body);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'a test file the live copy never got');
  const from = git(repo, 'rev-parse', 'HEAD').trim();
  git(repo, 'mv', `${SUB}/backend/tests/test_probe.py`, `${SUB}/backend/tests/test_probe_live.py`);
  write(repo, `${SUB}/backend/tests/test_probe_live.py`, body.replace('assert 1', 'assert 2'));
  git(repo, 'commit', '-qam', 'rename it');
  const log = quiet();
  const code = await main(['--alpha-root', join(f.live, '..'), '--repo', f.repo, '--from', from, '--ops', f.ops,
    '--skip-build', '--python', PY, '--apply'], log);
  assert.equal(code, 0, log.lines.join('\n'));
  assert.match(log.lines.join('\n'), /already +D backend\/tests\/test_probe\.py/);
  assert.match(readFileSync(join(f.live, 'backend/tests/test_probe_live.py'), 'utf8'), /assert 2/);
});

test('a broken line is placed among the changes made to its file', () => {
  const patch = ['diff --git a/backend/x.py b/backend/x.py', '@@ -10,3 +10,5 @@ def a():', ' x', 'diff --git a/backend/main.py b/backend/main.py',
    '@@ -1,4 +1,4 @@', ' a', '@@ -40,6 +42,8 @@ def b():', ' b'].join('\n');
  assert.equal(nearestHunk(patch, 'backend/main.py', 45), 'inside change #2 at lines 42-49');
  assert.equal(nearestHunk(patch, 'backend/main.py', 30), '12 line(s) from change #2 at lines 42-49');
  assert.equal(nearestHunk(patch, 'backend/main.py', 6), '2 line(s) from change #1 at lines 1-4');
  assert.equal(nearestHunk(patch, 'backend/other.py', 6), null);
  // Worker1 job 40: "line 18004, 2300 lines from the change": the hunk had
  // landed 2300 lines later in that machine's longer main.py.
  const log = ['Checking patch backend/x.py...', 'Hunk #1 succeeded at 99 (offset 89 lines).', 'Checking patch backend/main.py...',
    'Hunk #2 succeeded at 2340 (offset 2300 lines).', 'Applied patch backend/main.py cleanly.'].join('\n');
  assert.equal(nearestHunk(patch, 'backend/main.py', 2345, log), 'inside change #2 at lines 2342-2349, placed 2300 line(s) later than on the branch');
  assert.equal(nearestHunk(patch, 'backend/main.py', 6, log), '2 line(s) from change #1 at lines 1-4');
});

// 2026-10-07: files whose CRs were doubled on Worker1 (before #158) and
// captured back to the branch as CR-CR-LF refused every later change: the
// patch kept the CRs, the scratch copy did not, and no line matched.
test('a CRLF or CR-CR-LF file still takes a change, and comes back with single CRLF', { skip: !PY && 'no python' }, async () => {
  const f = fixture();
  const repo = f.repo.slice('file://'.length);
  const lines = ['export const a = 1', 'export const b = 2', 'export const c = 3', ''];
  write(repo, `${SUB}/frontend/src/doubled.js`, lines.join('\r\r\n'));
  write(repo, `${SUB}/frontend/src/crlf.js`, lines.join('\r\n'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'files as live sync captured them');
  const from = git(repo, 'rev-parse', 'HEAD').trim();
  write(repo, `${SUB}/frontend/src/doubled.js`, lines.join('\r\r\n').replace('b = 2', 'b = 20'));
  write(repo, `${SUB}/frontend/src/crlf.js`, lines.join('\r\n').replace('c = 3', 'c = 30'));
  git(repo, 'commit', '-qam', 'a change to each');
  write(f.live, 'frontend/src/doubled.js', lines.join('\r\r\n'));
  write(f.live, 'frontend/src/crlf.js', lines.join('\r\n'));
  const log = quiet();
  const code = await main(['--alpha-root', join(f.live, '..'), '--repo', f.repo, '--from', from, '--ops', f.ops, '--skip-build', '--python', PY, '--apply'], log);
  assert.equal(code, 0, log.lines.join('\n'));
  assert.doesNotMatch(log.lines.join('\n'), /conflict/);
  assert.equal(readFileSync(join(f.live, 'frontend/src/doubled.js'), 'utf8'), lines.join('\r\n').replace('b = 2', 'b = 20'));
  assert.equal(readFileSync(join(f.live, 'frontend/src/crlf.js'), 'utf8'), lines.join('\r\n').replace('c = 3', 'c = 30'));
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
  assert.deepEqual(lines, ['ls --depth=0 --silent', 'run build']);
});

test('packages left half-deleted by an earlier cut-short install are reinstalled before the build', { skip: (!PY || process.platform === 'win32') && 'needs python, not Windows' }, async () => {
  const f = fixture();
  mkdirSync(join(f.live, 'frontend', 'node_modules'));
  const bin = join(f.dir, 'bin');
  mkdirSync(bin);
  const calls = join(f.dir, 'npm-calls.txt');
  // `npm ls` fails: vite and friends are gone (Worker1, job 20261006-13).
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$@" >> "${calls}"\n[ "$1" = ls ] && exit 1\nexit 0\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const out = quiet();
    assert.equal(await main(args(f, '--apply').filter((x) => x !== '--skip-build'), out), 0, out.lines.join('\n'));
    assert.match(out.lines.join('\n'), /incomplete .*reinstalling/);
  } finally {
    process.env.PATH = path;
  }
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), ['ls --depth=0 --silent', 'ci --no-audit --no-fund', 'run build']);
});

// Worker1, 2026-10-06: `schtasks /End` left the old preview server on 4173,
// so the new vite.config's /music routes never took effect.
test('a restart stops whatever holds each port before running the task again', async () => {
  const { restartWindows } = await import('../scripts/apply-alpha-update.mjs');
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'powershell.exe') return { status: 0, stdout: args.at(-1).includes('4173') ? '1532 1532\r\n' : '2300\r\n' };
    return { status: 0, stdout: '' };
  };
  const lines = [];
  restartWindows((l) => lines.push(l), { spawn, isWindows: true });
  const order = calls.map((c) => c.replace(/powershell\.exe .*LocalPort (\d+).*/, 'ports $1'));
  assert.deepEqual(order, [
    'schtasks /Query /TN Alpha Backend', 'schtasks /End /TN Alpha Backend', 'ports 8001', 'taskkill.exe /T /F /PID 2300', 'schtasks /Run /TN Alpha Backend',
    'schtasks /Query /TN Alpha', 'schtasks /End /TN Alpha', 'ports 4173', 'taskkill.exe /T /F /PID 1532', 'schtasks /Run /TN Alpha',
  ]);
  assert.ok(lines.includes('  stopped pid 1532, which held port 4173'));
  const off = [];
  restartWindows((l) => off.push(l), { spawn: () => { throw new Error('must not run'); }, isWindows: false });
  assert.match(off[0], /only does something on the Windows host/);
});

test('line endings come back as the file had them, whatever git apply wrote', () => {
  // On Windows `git apply` writes CRLF into the scratch tree. Restoring CRLF on
  // top of that turned every line end of Worker1's alpha_agent_manager.ps1 into
  // CR-CR-LF, so each backtick continuation ended at the first CR and the next
  // line ran as a command ("The term '-ReceiptStatus' is not recognized").
  // Linux CI never sees CRLF from git apply, so this drives the writer directly.
  const dir = mkdtempSync(join(tmpdir(), 'alpha-eol-'));

  const crlfFile = join(dir, 'manager.ps1');
  writeLive(crlfFile, 'Get-Thing -A $a `\r\n    -B $b\r\n', { crlf: true });
  assert.equal(readFileSync(crlfFile, 'utf8'), 'Get-Thing -A $a `\r\n    -B $b\r\n');

  const lfFile = join(dir, 'site.css');
  writeLive(lfFile, '.a{color:green}\r\n.b{color:blue}\r\n', { crlf: false });
  assert.equal(readFileSync(lfFile, 'utf8'), '.a{color:green}\n.b{color:blue}\n');

  // A file already damaged that way reads as plain CRLF, so the next update heals it.
  writeFileSync(join(dir, 'damaged.ps1'), 'Get-Thing -A $a `\r\r\n    -B $b\r\r\n');
  const damaged = readLive(join(dir, 'damaged.ps1'));
  assert.equal(damaged.crlf, true);
  assert.equal(damaged.text, 'Get-Thing -A $a `\n    -B $b\n');
  writeLive(join(dir, 'damaged.ps1'), damaged.text, damaged);
  assert.equal(readFileSync(join(dir, 'damaged.ps1'), 'utf8'), 'Get-Thing -A $a `\r\n    -B $b\r\n');
});
test('a branch file stored with CRLF, or with the old CR-CR-LF, still takes an update', { skip: !PY && 'no python' }, async () => {
  // Live sync captures Worker1's files as they are, so the live branch holds
  // CRLF files (and seven with the CR-CR-LF damage from before #158). The
  // scratch tree is LF; a patch whose lines kept their CRs never matched it,
  // so every change to such a file was refused as "differs where the change
  // was made" (Worker1, 2026-10-07: MusicSingingPanel.jsx, CoordinationTunnelPanel.jsx).
  const dir = mkdtempSync(join(tmpdir(), 'alpha-update-crlf-'));
  const repo = join(dir, 'alpha');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'alpha-full');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'core.autocrlf', 'false');
  const panel = ['export const LIMIT = 180', 'export function Panel() {', '  return null', '}', ''].join('\r\n');
  const damaged = ['export const label = "old"', 'export const other = 1', ''].join('\r\r\n');
  write(repo, `${SUB}/backend/main.py`, BASE_MAIN);
  write(repo, `${SUB}/frontend/package.json`, '{"name":"x"}\n');
  write(repo, `${SUB}/frontend/src/Panel.jsx`, panel);
  write(repo, `${SUB}/frontend/src/labels.js`, damaged);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  write(repo, `${SUB}/frontend/src/Panel.jsx`, panel.replace('180', '240'));
  write(repo, `${SUB}/frontend/src/labels.js`, damaged.replace('"old"', '"new"'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'update');

  const live = join(dir, 'live', 'software');
  write(live, 'backend/main.py', BASE_MAIN);
  write(live, 'frontend/package.json', '{"name":"x"}\n');
  write(live, 'frontend/src/Panel.jsx', panel);
  write(live, 'frontend/src/labels.js', damaged);
  const log = quiet();
  const code = await main(['--alpha-root', join(live, '..'), '--repo', `file://${repo}`, '--from', base, '--ops', join(dir, 'ops'),
    '--skip-build', '--python', PY, '--apply'], log);
  assert.equal(code, 0, log.lines.join('\n'));
  assert.equal(readFileSync(join(live, 'frontend/src/Panel.jsx'), 'utf8'), panel.replace('180', '240'));
  // The damaged file takes the change and comes back as plain CRLF.
  assert.equal(readFileSync(join(live, 'frontend/src/labels.js'), 'utf8'), 'export const label = "new"\r\nexport const other = 1\r\n');
});
