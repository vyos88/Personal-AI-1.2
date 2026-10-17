// channel-watch: a quiet status channel is reported by someone other than the
// machine that went quiet. Run against a real git remote with real commit
// times, because "how old is the last write" is the whole of what it knows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeQueued, formatReport, judgeChannels, liveMachine, parseChannels } from '../scripts/channel-watch.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'channel-watch.mjs');
const git = (cwd, env, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] });

test('channels are name:minutes, and anything else is refused before git is asked', () => {
  assert.deepEqual(parseChannels('laptop41-live:30, laptop41:45'), [
    { name: 'laptop41-live', staleMin: 30 },
    { name: 'laptop41', staleMin: 45 },
  ]);
  for (const bad of ['', 'x', 'x:2', 'x:abc', '../x:30', 'x:30;rm']) assert.throws(() => parseChannels(bad), bad);
});

test('the verdict carries no age, so the same silence reads the same on every pass', () => {
  const now = Date.parse('2026-10-08T03:00:00Z');
  const channels = parseChannels('live:30,doctor:45,gone:30');
  const writes = { live: now / 1000 - 10 * 60, doctor: now / 1000 - 3 * 3600 };
  const results = judgeChannels(channels, writes, now);
  assert.deepEqual(results.map((r) => r.verdict), ['OK', 'SILENT', 'MISSING']);
  const text = formatReport(results);
  assert.match(text, /^OK: status\/live$/m);
  assert.match(text, /^SILENT: status\/doctor \(last write 2026-10-08T00:00:00Z\)$/m);
  assert.match(text, /^MISSING: status\/gone$/m);
  assert.match(text, /ages: live 10 min/);
});

test('a silent heartbeat names the work it has stranded, below the verdict lines', () => {
  const now = Date.parse('2026-10-08T03:35:00Z');
  const sec = (iso) => Date.parse(iso) / 1000;
  const liveAt = sec('2026-10-07T23:29:08Z');
  const channels = parseChannels('laptop41-live:30,laptop41:45');
  const results = judgeChannels(channels, { 'laptop41-live': liveAt, laptop41: now / 1000 - 120 }, now);
  assert.deepEqual(results.map((r) => r.verdict), ['SILENT', 'OK']);

  const queued = { laptop41: ['2026-10-08T03:10:03Z', '2026-10-08T02:24:00Z', '2026-10-08T00:12:00Z', '2026-10-07T22:00:00Z'].map(sec) };
  const text = formatReport(results, queued);
  // autopilot.ps1:751 keys off the OK/SILENT/MISSING lines, so this one is
  // indented: three commits becoming four must not re-report the same silence.
  assert.match(text, /^SILENT: status\/laptop41-live \(last write 2026-10-07T23:29:08Z\)$/m);
  assert.match(text, /^ {2}control\/laptop41: 3 commit\(s\) pushed since that last write \(newest 2026-10-08T03:10:03Z\), and nothing has run them$/m);
  assert.ok(text.indexOf('ages:') < text.indexOf('control/laptop41:'), 'it goes below the ages line');

  // Only the heartbeat channel asks the question, and only while it is silent.
  assert.equal(liveMachine('laptop41-live'), 'laptop41');
  assert.equal(liveMachine('laptop41'), null);
  assert.doesNotMatch(formatReport(judgeChannels(channels, { 'laptop41-live': now / 1000 - 60, laptop41: now / 1000 }, now), queued), /control\//);
});

test('a queue with nothing newer than the last pass says nothing', () => {
  const liveAt = Date.parse('2026-10-08T03:00:00Z') / 1000;
  assert.equal(describeQueued({ machine: 'laptop41', commits: [liveAt - 60, liveAt], liveAt }), null,
    'a commit the last pass could have run is not stranded');
  assert.equal(describeQueued({ machine: 'laptop41', commits: [], liveAt }), null, 'no queue branch, nothing to say');
  assert.equal(describeQueued({ machine: 'laptop41', commits: [NaN], liveAt }), null);
  assert.match(describeQueued({ machine: 'host', commits: [liveAt + 1], liveAt }), /^ {2}control\/host: 1 commit\(s\)/);
});

test('read from a real remote: a talking channel, a silent one and a missing one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-watch-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  git(dir, {}, 'init', '-q', '--bare', remote);
  git(dir, {}, 'clone', '-q', remote, work);
  const push = (branch, iso) => {
    git(work, {}, 'checkout', '-q', '--orphan', branch);
    writeFileSync(join(work, 'r.md'), branch);
    git(work, {}, 'add', 'r.md');
    git(work, { GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso }, 'commit', '-qm', branch);
    git(work, {}, 'push', '-q', 'origin', branch);
  };
  push('status/live', '2026-10-08T02:55:00Z');
  push('status/doctor', '2026-10-07T23:24:00Z');
  const watcher = join(dir, 'watcher');
  git(dir, {}, 'clone', '-q', remote, watcher);

  const r = spawnSync(process.execPath, [SCRIPT, '--repo', watcher, '--channels', 'live:30,doctor:45,gone:30', '--now', String(Date.parse('2026-10-08T03:00:00Z'))], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /^OK: status\/live$/m);
  assert.match(r.stdout, /^SILENT: status\/doctor \(last write 2026-10-07T23:24:00Z\)$/m);
  assert.match(r.stdout, /^MISSING: status\/gone$/m);

  const fine = spawnSync(process.execPath, [SCRIPT, '--repo', watcher, '--channels', 'live:30', '--now', String(Date.parse('2026-10-08T03:00:00Z'))], { encoding: 'utf8' });
  assert.equal(fine.status, 0, fine.stdout);
});
