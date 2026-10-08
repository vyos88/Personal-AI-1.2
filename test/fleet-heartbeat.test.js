import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_STALE_MIN, ageMinutes, main, parseArgs, parseLive, verdict } from '../scripts/fleet-heartbeat.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

const NOW = Date.parse('2026-10-08T02:34:44Z');

test('the live report is read through its BOM, and a machine with none is not a fault', () => {
  // Publish-Live writes a BOM; a reader that forgets it calls a live machine unreadable.
  assert.deepEqual(parseLive('﻿{"at":"2026-10-08T00:29:06.4847119+01:00"}'), { at: '2026-10-08T00:29:06.4847119+01:00' });
  assert.equal(parseLive('not json'), null);
  assert.equal(parseLive('[1,2]'), null, 'an array is not a report');
  assert.equal(parseLive(null), null);
  assert.equal(verdict({ live: null }).ok, true, 'never published is not stale');
});

test('age is taken from the instant, not from the text', () => {
  // The report carries the machine's own offset and the deck receipt inside it
  // is UTC: 00:29 +01:00 against 02:34Z is 185 minutes, not 125.
  assert.equal(ageMinutes('2026-10-08T00:29:06.4847119+01:00', NOW), 185.6);
  assert.equal(ageMinutes('2026-10-07T23:19:11.415357+00:00', NOW), 195.5);
  assert.equal(ageMinutes('not a time', NOW), null);
  assert.equal(ageMinutes(undefined, NOW), null);
});

test('a live report within three passes is current, and one past them is not', () => {
  const live = { at: '2026-10-08T02:30:00Z' };
  assert.equal(DEFAULT_STALE_MIN, 15);
  assert.equal(verdict({ live, liveAgeMin: 4.7 }).state, 'OK');
  assert.equal(verdict({ live, liveAgeMin: 15 }).state, 'OK', 'the limit itself is still current');
  assert.equal(verdict({ live, liveAgeMin: 15.1 }).state, 'STALE');
  assert.equal(verdict({ live, liveAgeMin: 30, staleMin: 45 }).state, 'OK');
  assert.equal(verdict({ live, liveAgeMin: null }).state, 'UNREADABLE');
  assert.equal(verdict({ live, liveAgeMin: null }).ok, false);
});

test('a silent report branch is never read as a stall, and is said not to be', () => {
  // autopilot.ps1:733 pushes that branch only when a queued id ran, so hours of
  // silence there are ordinary -- the mistake this line exists to prevent.
  const ok = verdict({ live: { at: 'x' }, liveAgeMin: 3, autopilotAgeMin: 600 });
  assert.equal(ok.state, 'OK');
  assert.match(ok.notes.join('\n'), /not a fault on its own: it is pushed only when a queued id ran/);
});

test('work queued after the last completed pass is named, because that is the cost', () => {
  const stale = verdict({ live: { at: 'x' }, liveAgeMin: 187.3, queuedAgeMin: 8.7 });
  assert.equal(stale.state, 'STALE');
  assert.match(stale.notes.join('\n'), /work was queued 8\.7 min ago, after that last pass, and nothing has run it/);
  // Queued before the last pass says nothing: that pass may well have run it.
  const older = verdict({ live: { at: 'x' }, liveAgeMin: 187.3, queuedAgeMin: 300 });
  assert.doesNotMatch(older.notes.join('\n'), /work was queued/);
  // And a current machine is not told about a queue it is about to drain.
  assert.doesNotMatch(verdict({ live: { at: 'x' }, liveAgeMin: 2, queuedAgeMin: 1 }).notes.join('\n'), /work was queued/);
});

test('the options are the ones documented, and a bad one is refused', () => {
  assert.deepEqual(parseArgs([]).machines, ['laptop41', 'host']);
  const o = parseArgs(['--machine', 'laptop41', '--stale-min', '7', '--remote', 'upstream', '--json']);
  assert.deepEqual(o, { remote: 'upstream', machines: ['laptop41'], staleMin: 7, json: true });
  assert.throws(() => parseArgs(['--stale-min', 'soon']), /needs a number of minutes/);
  assert.throws(() => parseArgs(['--stale-min']), /needs a value/);
  assert.throws(() => parseArgs(['--what']), /unknown option --what/);
});

test('it reads a real remote and exits 1 on a stalled machine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-heartbeat-'));
  const work = join(dir, 'work');
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'README'), 'x\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'base');
  const remote = join(dir, 'fleet.git');
  git(dir, 'clone', '-q', '--bare', work, remote);
  git(work, 'remote', 'add', 'origin', remote);

  const publish = (branch, at) => {
    mkdirSync(join(work, 'reports'), { recursive: true });
    // With the BOM, as Publish-Live writes it.
    writeFileSync(join(work, 'reports/live.json'), `﻿${JSON.stringify({ at, machine: 'T', alpha: { verdict: 'LIVE' } })}`);
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', `live ${at}`);
    git(work, 'push', '-q', 'origin', `HEAD:${branch}`);
  };
  const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

  publish('status/wedged-live', minutesAgo(187));
  publish('status/fine-live', minutesAgo(3));
  git(work, 'push', '-q', 'origin', 'HEAD:control/wedged');

  const checkout = join(dir, 'clone');
  git(dir, 'clone', '-q', remote, checkout);
  const run = async (...extra) => {
    const lines = [];
    const code = await main(['--remote', remote, ...extra], (l) => lines.push(String(l)));
    return { code, out: lines.join('\n') };
  };
  const before = process.cwd();
  process.chdir(checkout);
  try {
    const stalled = await run('--machine', 'wedged');
    assert.equal(stalled.code, 1, stalled.out);
    assert.match(stalled.out, /^wedged {2}STALE {2}live report 18[67](\.\d)? min old \(stale past 15\)/m);
    assert.match(stalled.out, /work was queued 0(\.\d)? min ago, after that last pass/);

    const fine = await run('--machine', 'fine');
    assert.equal(fine.code, 0, fine.out);
    assert.match(fine.out, /^fine {2}OK {2}live report 3(\.\d)? min old/m);

    // One stalled machine among several is still a failure, and the others are
    // still reported: a fleet view that stops at the first problem hides the rest.
    const both = await run('--machine', 'fine', '--machine', 'wedged');
    assert.equal(both.code, 1);
    assert.match(both.out, /fine {2}OK/);
    assert.match(both.out, /wedged {2}STALE/);

    const absent = await run('--machine', 'nosuch');
    assert.equal(absent.code, 0, 'a machine that never published is not a fault');
    assert.match(absent.out, /nosuch {2}NO REPORT/);

    const json = await run('--machine', 'wedged', '--json');
    const parsed = JSON.parse(json.out);
    assert.equal(parsed.staleMin, 15);
    assert.equal(parsed.machines[0].state, 'STALE');
    assert.ok(parsed.machines[0].liveAgeMin > 180);
  } finally {
    process.chdir(before);
  }
});
