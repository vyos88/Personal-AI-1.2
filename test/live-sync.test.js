import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { capturableTracked, main, neverTried, syncStatePath, UPDATER_VERSION } from '../scripts/live-sync.mjs';

const BASE = 'BuildArtifacts/installers/Alpha-Full';
const SUB = `${BASE}/software`;
const PY = (() => {
  for (const name of ['python3', 'python']) {
    try { execFileSync(name, ['--version']); return name; } catch { /* next */ }
  }
  return null;
})();
const skip = !PY && 'no python';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });

function write(root, rel, text) {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const MAIN = ['import os', '', 'def login():', '    return "old"', '', '', 'def other():', '    return 1', ''].join('\n');
const STEWARD = ['# steward', '$every = 30', ''].join('\n');

/**
 * A stand-in for vyos88/Alpha with a live branch, and a machine that runs
 * exactly that branch's tip: the same files, and a record saying so.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'live-sync-'));
  const work = join(dir, 'work');
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'live');
  write(work, `${SUB}/backend/main.py`, MAIN);
  write(work, `${SUB}/frontend/package.json`, '{"name":"x"}\n');
  write(work, `${BASE}/scripts/steward.ps1`, STEWARD);
  write(work, 'Models/notes.txt', 'outside software/ and scripts/\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'live base');
  const base = git(work, 'rev-parse', 'HEAD').trim();
  const remote = join(dir, 'alpha.git');
  git(dir, 'clone', '-q', '--bare', work, remote);
  git(work, 'remote', 'add', 'origin', remote);

  const alpha = join(dir, 'live');
  write(alpha, 'software/backend/main.py', MAIN);
  write(alpha, 'software/frontend/package.json', '{"name":"x"}\n');
  write(alpha, 'scripts/steward.ps1', STEWARD);
  const ops = join(dir, 'ops');
  write(ops, 'applied-live.json', JSON.stringify({ to: base, scripts_to: base }));
  return { dir, work, remote, alpha, ops, base };
}

function commitOnLive(f, files, message = 'a fix on the live branch') {
  git(f.work, 'fetch', '-q', 'origin', 'live');
  git(f.work, 'reset', '-q', '--hard', 'origin/live');
  for (const [rel, text] of Object.entries(files)) write(f.work, rel, text);
  git(f.work, 'add', '-A');
  git(f.work, 'commit', '-qm', message);
  git(f.work, 'push', '-q', 'origin', 'HEAD:live');
  return git(f.work, 'rev-parse', 'HEAD').trim();
}

async function run(f, ...extra) {
  const lines = [];
  const code = await main(['--alpha-root', f.alpha, '--branch', 'live', '--ops', f.ops, '--repo', `file://${f.remote}`,
    '--no-restart', '--machine', 'worker1', ...(PY ? ['--python', PY] : []), ...extra], (l) => lines.push(String(l)));
  return { code, out: lines.join('\n') };
}

const remoteTip = (f) => git(f.remote, 'rev-parse', 'live').trim();
const recorded = (f) => JSON.parse(readFileSync(join(f.ops, 'applied-live.json'), 'utf8'));

test('a new commit on the live branch is delivered once, and then it is in sync', { skip }, async () => {
  const f = fixture();
  const tip = commitOnLive(f, { [`${SUB}/backend/main.py`]: MAIN.replace('"old"', '"new"') });

  const first = await run(f);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, new RegExp(`DELIVERED: ${f.base.slice(0, 7)}\\.\\.${tip.slice(0, 7)} of live`));
  assert.match(readFileSync(join(f.alpha, 'software/backend/main.py'), 'utf8'), /return "new"/);
  assert.equal(recorded(f).to, tip);

  const second = await run(f);
  assert.equal(second.code, 0);
  assert.match(second.out, new RegExp(`IN SYNC: this machine runs ${tip.slice(0, 7)} of live`));
  assert.doesNotMatch(second.out, /changes:/, 'nothing was applied again');
});

test('a refused delivery is not retried until the branch moves', { skip }, async () => {
  const f = fixture();
  write(f.alpha, 'software/backend/main.py', MAIN.replace('"old"', '"edited on this machine"'));
  const tip = commitOnLive(f, { [`${SUB}/backend/main.py`]: MAIN.replace('"old"', '"new"') });

  const first = await run(f);
  assert.equal(first.code, 2, first.out);
  assert.match(first.out, new RegExp(`REFUSED: ${tip.slice(0, 7)}`));
  assert.match(first.out, /conflict +M backend\/main\.py/, "apply-alpha-update's own words are shown");

  const second = await run(f);
  assert.equal(second.code, 2);
  assert.match(second.out, new RegExp(`WAITING: ${tip.slice(0, 7)} was tried here and refused`));
  assert.doesNotMatch(second.out, /changes:/, 'the same tip is not tried twice');

  // A refusal by an older updater gets one more try at the same tip.
  const statePath = syncStatePath(f.ops, 'live');
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(st.deliver.updater, UPDATER_VERSION);
  writeFileSync(statePath, JSON.stringify({ ...st, deliver: { ...st.deliver, updater: 'older' } }));
  const retried = await run(f);
  assert.match(retried.out, new RegExp(`REFUSED: ${tip.slice(0, 7)}`), 'the same tip is tried again by a new updater');
  assert.match((await run(f)).out, /WAITING/, 'and then waits again');

  const next = commitOnLive(f, { [`${SUB}/frontend/README.md`]: 'more\n' }, 'another commit');
  const third = await run(f, '--skip-build');
  assert.match(third.out, new RegExp(`REFUSED: ${next.slice(0, 7)}`), 'a new tip is tried');
  assert.equal(recorded(f).to, f.base);
});

test('capture pushes what this machine runs, fast-forward, in the repository\'s shape, and holds back credential-looking files', { skip }, async () => {
  const f = fixture();
  // Worker1 writes CRLF and a BOM; the branch keeps LF and no BOM.
  const edited = MAIN.replace('return 1', 'return 2  # fixed on this machine');
  write(f.alpha, 'software/backend/main.py', `﻿${edited.replace(/\n/g, '\r\n')}`);
  write(f.alpha, 'software/backend/gpu_work.py', 'def gpus():\n    return []\n');
  write(f.alpha, 'software/backend/provider_keys.py', 'openai_api_key = "abcdefghijklmnop1234567890"\n');
  write(f.alpha, 'software/backend/data/cache.py', 'x = 1\n');
  write(f.alpha, 'software/frontend/dist/app.js', 'built()\n');
  write(f.alpha, 'software/backend/notes.txt', 'not source\n');

  const first = await run(f, '--capture');
  assert.equal(first.code, 2, first.out);
  assert.match(first.out, /CAPTURED: 1 changed and 1 new source file\(s\) from worker1, pushed as \w{7} on live/);
  assert.match(first.out, /HELD BACK: 1 file\(s\) with credential-looking lines, not pushed: software\/backend\/provider_keys\.py/);
  assert.match(first.out, /provider_keys\.py:1 {2}credential-looking assignment/);
  assert.doesNotMatch(first.out, /abcdefghijklmnop1234567890/, 'a value is never printed whole');

  const tip = remoteTip(f);
  assert.equal(git(f.remote, 'rev-parse', 'live^').trim(), f.base, 'one commit on top: a fast-forward');
  assert.equal(git(f.remote, 'log', '-1', '--format=%an', 'live').trim(), 'Alpha host');
  assert.equal(git(f.remote, 'show', `live:${SUB}/backend/main.py`), edited, 'LF and no BOM, as the branch had it');
  assert.equal(git(f.remote, 'show', `live:${SUB}/backend/gpu_work.py`), 'def gpus():\n    return []\n');
  const files = git(f.remote, 'ls-tree', '-r', '--name-only', 'live');
  for (const absent of ['backend/provider_keys.py', 'backend/data/cache.py', 'frontend/dist/app.js', 'backend/notes.txt']) {
    assert.ok(!files.split('\n').includes(`${SUB}/${absent}`), `${absent} stays on this machine`);
  }
  assert.ok(files.split('\n').includes('Models/notes.txt'), 'what is outside software/ and scripts/ is untouched');
  assert.equal(recorded(f).to, tip, 'what was pushed is recorded as applied here');
  assert.equal(recorded(f).scripts_to, tip);

  const second = await run(f, '--capture');
  assert.match(second.out, new RegExp(`IN SYNC: this machine runs ${tip.slice(0, 7)} of live`));
  assert.match(second.out, /HELD BACK: 1 file\(s\)/, 'the last capture is reported until the next one is due');
  assert.equal(remoteTip(f), tip, 'nothing new was pushed');
});

test('the owner\'s approved lines go at once, exactly those lines and no others', { skip }, async () => {
  const f = fixture();
  write(f.alpha, 'software/backend/provider_keys.py', 'storage_key = "educational_lesson_store"\n');
  write(f.alpha, 'software/backend/other_keys.py', 'cache_token = "a_very_long_cache_name_here"\n');

  const first = await run(f, '--capture');
  assert.equal(first.code, 2, first.out);
  assert.match(first.out, /^ALLOW WITH: software\/backend\/other_keys\.py:1,software\/backend\/provider_keys\.py:1$/m);
  const before = remoteTip(f);

  // Within the hour, but the list changed: captured now. Only the approved line goes.
  const second = await run(f, '--capture', '--allow', 'software/backend/provider_keys.py:1');
  assert.equal(second.code, 2, second.out);
  assert.match(second.out, /CAPTURED: 0 changed and 1 new source file\(s\)/);
  assert.match(second.out, /1 credential-looking line\(s\) cleared by the owner's list go with this capture/);
  assert.match(second.out, /^ALLOW WITH: software\/backend\/other_keys\.py:1$/m);
  assert.notEqual(remoteTip(f), before);
  const files = git(f.remote, 'ls-tree', '-r', '--name-only', 'live').split('\n');
  assert.ok(files.includes(`${SUB}/backend/provider_keys.py`));
  assert.ok(!files.includes(`${SUB}/backend/other_keys.py`), 'a line nobody approved stays here');

  // An approval for a line that is not the one found does not clear it.
  write(f.alpha, 'software/backend/other_keys.py', '# moved\ncache_token = "a_very_long_cache_name_here"\n');
  const third = await run(f, '--capture', '--allow', 'software/backend/provider_keys.py:1,software/backend/other_keys.py:1');
  assert.match(third.out, /^ALLOW WITH: software\/backend\/other_keys\.py:2$/m);
  assert.ok(!git(f.remote, 'ls-tree', '-r', '--name-only', 'live').split('\n').includes(`${SUB}/backend/other_keys.py`));
});

test('a fetch that never reached the patch is not a tip that was tried', () => {
  // apply-alpha-update exits 1 both ways, so its words are what tell them apart.
  assert.equal(neverTried(["STOP: could not fetch alpha-full: fatal: unable to access 'https://github.com/vyos88/Alpha/': Empty reply from server"]), true);
  assert.equal(neverTried(['changes: a3e1350..5147fef of live', 'STOP: backend/main.py no longer parses, and was put back']), false);
  assert.equal(neverTried(['READY: 3 file(s) would change']), false);
  assert.equal(neverTried([]), false);
});

test('a tip the repository could not be fetched for is tried again next pass', { skip }, async () => {
  const f = fixture();
  const tip = commitOnLive(f, { [`${SUB}/backend/main.py`]: MAIN.replace('"old"', '"new"') });

  const gone = await main(['--alpha-root', f.alpha, '--branch', 'live', '--ops', f.ops,
    '--repo', `file://${join(f.dir, 'nope')}`, '--no-restart', '--machine', 'worker1'], () => {});
  assert.equal(gone, 1);
  const state = JSON.parse(readFileSync(syncStatePath(f.ops, 'live'), 'utf8'));
  assert.equal(state.deliver, undefined, 'nothing about this tip was written down');

  const back = await run(f);
  assert.match(back.out, new RegExp(`DELIVERED: ${f.base.slice(0, 7)}\\.\\.${tip.slice(0, 7)}`), 'the same tip is tried again');
});

test('an allow entry that is not path:line is refused', async () => {
  const lines = [];
  assert.equal(await main(['--alpha-root', '/nowhere', '--branch', 'live', '--allow', 'software/x.py'], (l) => lines.push(l)), 1);
  assert.match(lines.join('\n'), /--allow entries must be path:line/);
});

test('nothing is captured while this machine is behind the branch', { skip }, async () => {
  const f = fixture();
  write(f.alpha, 'software/backend/main.py', MAIN.replace('"old"', '"edited on this machine"'));
  const tip = commitOnLive(f, { [`${SUB}/backend/main.py`]: MAIN.replace('"old"', '"new"') });

  const r = await run(f, '--capture');
  assert.equal(r.code, 2);
  assert.match(r.out, /REFUSED/);
  assert.match(r.out, new RegExp(`SKIPPED: nothing is captured while this machine is not on ${tip.slice(0, 7)}`));
  assert.equal(remoteTip(f), tip, 'this machine\'s older main.py never went over the fix');
});

test('scripts are captured only when they were applied up to the same tip', { skip }, async () => {
  const f = fixture();
  write(f.ops, 'applied-live.json', JSON.stringify({ to: f.base, scripts_to: null }));
  write(f.alpha, 'scripts/steward.ps1', STEWARD.replace('30', '60'));
  write(f.alpha, 'software/backend/gpu_work.py', 'def gpus():\n    return []\n');

  const r = await run(f, '--capture');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SKIPPED: scripts\\ is not captured: its last update here was never/);
  assert.match(r.out, /CAPTURED: 0 changed and 1 new/);
  assert.equal(git(f.remote, 'show', `live:${BASE}/scripts/steward.ps1`), STEWARD, 'the scripts were left as the branch has them');
  assert.equal(recorded(f).scripts_to, null);
});

test('a refused push is reported and never forced', { skip }, async () => {
  const f = fixture();
  const hook = join(f.remote, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "someone else pushed first" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  write(f.alpha, 'software/backend/gpu_work.py', 'def gpus():\n    return []\n');

  const r = await run(f, '--capture');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SKIPPED: the push was refused/);
  assert.equal(remoteTip(f), f.base);
  assert.equal(recorded(f).to, f.base, 'nothing is recorded as applied that was not pushed');
  assert.ok(existsSync(join(f.ops, 'live-sync-live.json')));
});

test('a branch that is not a live branch is refused', async () => {
  const lines = [];
  assert.equal(await main(['--alpha-root', '/nowhere', '--branch', 'alpha-full'], (l) => lines.push(l)), 1);
  assert.equal(await main(['--alpha-root', '/nowhere', '--branch', '../../etc'], (l) => lines.push(l)), 1);
  assert.match(lines.join('\n'), /installer's branch, not a live one/);
  assert.match(lines.join('\n'), /plain branch name/);
});

test('only source, package and requirements files are overlaid, outside data and build folders', () => {
  assert.equal(capturableTracked('software/backend/main.py'), true);
  assert.equal(capturableTracked('software/frontend/package-lock.json'), true);
  assert.equal(capturableTracked('software/backend/requirements.txt'), true);
  assert.equal(capturableTracked('software/frontend/dist/assets/index.js'), false);
  assert.equal(capturableTracked('software/backend/memory/state.py'), false);
  assert.equal(capturableTracked('software/backend/settings.json'), false);
  assert.equal(capturableTracked('software/backend/.cache/x.py'), false);
});

test("the branch's knowledge documents teach this machine's Alpha, and one edited here is kept", { skip }, async () => {
  const f = fixture();
  const K = `${BASE}/memory/knowledge`;
  const live = (name) => join(f.alpha, 'memory', 'knowledge', name);
  write(f.alpha, 'memory/knowledge/alpha_same.json', '{"a":1}\r\n');
  commitOnLive(f, {
    [`${K}/alpha_new.json`]: '{"title":"v1"}\n',
    [`${K}/alpha_edited.json`]: '{"title":"v1"}\n',
    [`${K}/alpha_same.json`]: '{"a":1}\n',
    [`${K}/alpha_list.json`]: '[1]\n',
    [`${K}/notes.txt`]: 'not a document\n',
    [`${K}/old/alpha_nested.json`]: '{}\n',
  }, 'knowledge only');

  const first = await run(f);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /KNOWLEDGE: 2 document\(s\) for Alpha written to memory\\knowledge: alpha_edited\.json, alpha_new\.json/);
  assert.match(first.out, /KNOWLEDGE: 1 document\(s\) on the branch are not a JSON object and were not written: alpha_list\.json/);
  assert.match(first.out, /restart Alpha Backend so Alpha reads them/);
  assert.equal(readFileSync(live('alpha_new.json'), 'utf8'), '{"title":"v1"}\n');
  assert.equal(readFileSync(live('alpha_same.json'), 'utf8'), '{"a":1}\r\n', 'line ends alone are not rewritten');
  for (const name of ['alpha_list.json', 'notes.txt', 'old/alpha_nested.json']) assert.ok(!existsSync(live(name)), name);

  // Edited here: kept, and named on every pass. Untouched since delivery: updated.
  writeFileSync(live('alpha_edited.json'), '{"title":"mine"}\n');
  commitOnLive(f, { [`${K}/alpha_new.json`]: '{"title":"v2"}\n', [`${K}/alpha_edited.json`]: '{"title":"v2"}\n' }, 'knowledge v2');
  const second = await run(f);
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /KNOWLEDGE: 1 document\(s\) for Alpha written to memory\\knowledge: alpha_new\.json\n/);
  assert.match(second.out, /KNOWLEDGE: 1 document\(s\) differ here from the branch and are kept as they are: alpha_edited\.json/);
  assert.equal(readFileSync(live('alpha_new.json'), 'utf8'), '{"title":"v2"}\n');
  assert.equal(readFileSync(live('alpha_edited.json'), 'utf8'), '{"title":"mine"}\n');

  const third = await run(f);
  assert.match(third.out, /IN SYNC/);
  assert.doesNotMatch(third.out, /for Alpha written|restart Alpha Backend/, 'nothing new, no restart');
  assert.match(third.out, /kept as they are: alpha_edited\.json/);

  // A document removed from the branch stays here: nothing is deleted.
  git(f.work, 'rm', '-q', `${K}/alpha_new.json`);
  git(f.work, 'commit', '-qm', 'drop one');
  git(f.work, 'push', '-q', 'origin', 'HEAD:live');
  await run(f);
  assert.ok(existsSync(live('alpha_new.json')));
});
