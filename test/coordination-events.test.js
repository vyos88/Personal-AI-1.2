// Merging a standby's copy of Alpha's coordination log back into Worker1's
// (Alpha's WORKER1_FAILOVER_PLAN.md, step 1d). The library is tested directly;
// the script is run as a real subprocess against real files, because what it
// must never do is write to the master when it refuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendText, masterIds, planMerge, readIncoming } from '../src/common/coordination-events.js';

const SCRIPT = fileURLToPath(new URL('../scripts/merge-coordination-events.mjs', import.meta.url));

// The shape alpha_coordination_tunnel.ps1 writes, compressed onto one line.
const event = (id, at, machine = 'desktop-41hplcn', message = 'note') =>
  JSON.stringify({
    schema: 'alpha.coordination.event.v1',
    id,
    at,
    actor: 'claude',
    machine,
    kind: 'post',
    message,
    paths: [],
  });

const id = (n) => n.toString(16).padStart(32, '0');
const jsonl = (...rows) => rows.map((row) => `${row}\n`).join('');

test('no overlap: every incoming event is appended, oldest first', () => {
  const master = jsonl(event(id(1), '2026-10-05T20:00:00.0000000+00:00'));
  const incoming = jsonl(
    event(id(3), '2026-10-05T22:10:00.0000000+00:00', 'laptop-gj8dfmlk'),
    event(id(2), '2026-10-05T22:05:00.0000000+00:00', 'laptop-gj8dfmlk'),
  );
  const plan = planMerge(master, incoming);
  assert.deepEqual(plan.ids, [id(2), id(3)]);
  assert.equal(plan.alreadyPresent, 0);
});

test('full overlap: nothing to append', () => {
  const rows = [event(id(1), '2026-10-05T20:00:00Z'), event(id(2), '2026-10-05T20:01:00Z')];
  const plan = planMerge(jsonl(...rows), jsonl(...rows));
  assert.deepEqual(plan.append, []);
  assert.equal(plan.alreadyPresent, 2);
  assert.equal(appendText(jsonl(...rows), plan.append), '');
});

test('the standby copy starts as a snapshot of the master, so only its tail is new', () => {
  const shared = [event(id(1), '2026-10-05T20:00:00Z'), event(id(2), '2026-10-05T20:10:00Z')];
  // Worker1 wrote one more event after the last copy reached the Host.
  const master = jsonl(...shared, event(id(4), '2026-10-05T20:15:00Z'));
  const incoming = jsonl(...shared, event(id(3), '2026-10-05T20:20:00Z', 'laptop-gj8dfmlk'));
  const plan = planMerge(master, incoming);
  assert.deepEqual(plan.ids, [id(3)]);
  assert.equal(plan.alreadyPresent, 2);
});

test('equal times keep the incoming order, and a repeated id is appended once', () => {
  const at = '2026-10-05T22:00:00Z';
  const incoming = jsonl(event(id(9), at), event(id(8), at), event(id(9), at));
  const plan = planMerge('', incoming);
  assert.deepEqual(plan.ids, [id(9), id(8)]);
  assert.equal(plan.alreadyPresent, 1);
});

test('lines are copied as written, with a BOM and CRLF endings dropped', () => {
  const row = event(id(5), '2026-10-05T22:00:00Z', 'laptop-gj8dfmlk', 'quotes "and" ünïcode');
  const plan = planMerge('', `﻿${row}\r\n`);
  assert.deepEqual(plan.append, [row]);
});

test('a bad incoming line is refused, naming it', () => {
  const good = event(id(1), '2026-10-05T20:00:00Z');
  assert.throws(() => readIncoming(jsonl(good, '{"id": "x", "at": ')), /line 2 is not valid JSON/);
  assert.throws(() => readIncoming(jsonl(good, '[1,2]')), /line 2 is not a JSON object/);
  assert.throws(() => readIncoming(jsonl('{"at":"2026-10-05T20:00:00Z"}')), /line 1 has no "id"/);
  assert.throws(() => readIncoming(jsonl(`{"id":"${id(2)}","at":"soon"}`)), /no readable "at"/);
});

test('an unreadable master line is counted and left alone', () => {
  const { ids, unreadable } = masterIds(jsonl('not json', '{"no":"id"}', event(id(1), '2026-10-05T20:00:00Z')));
  assert.deepEqual([...ids], [id(1)]);
  assert.equal(unreadable, 2);
});

test('appendText adds the newline a master without one is missing', () => {
  assert.equal(appendText('a', ['b']), '\nb\n');
  assert.equal(appendText('a\n', ['b', 'c']), 'b\nc\n');
  assert.equal(appendText('', ['b']), 'b\n');
});

// ------------------------------------------------------------- the script

function files(master, incoming) {
  const dir = mkdtempSync(join(tmpdir(), 'coord-merge-'));
  const paths = { master: join(dir, 'master.jsonl'), incoming: join(dir, 'standby.jsonl') };
  writeFileSync(paths.master, master);
  writeFileSync(paths.incoming, incoming);
  return paths;
}

const runScript = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('the script appends once, and a second run adds nothing', () => {
  const first = event(id(1), '2026-10-05T20:00:00Z');
  const drill = event(id(2), '2026-10-05T22:00:00Z', 'laptop-gj8dfmlk', 'failover drill');
  const paths = files(jsonl(first), jsonl(first, drill));

  const once = runScript('--master', paths.master, '--incoming', paths.incoming);
  assert.equal(once.status, 0, once.stderr);
  assert.deepEqual(JSON.parse(once.stdout), {
    merged: true,
    added: 1,
    alreadyPresent: 1,
    masterUnreadable: 0,
    ids: [id(2)],
  });
  assert.equal(readFileSync(paths.master, 'utf8'), jsonl(first, drill));

  const twice = runScript('--master', paths.master, '--incoming', paths.incoming);
  assert.equal(twice.status, 0, twice.stderr);
  assert.equal(JSON.parse(twice.stdout).added, 0);
  assert.equal(readFileSync(paths.master, 'utf8'), jsonl(first, drill));
});

test('--dry-run reports without writing', () => {
  const paths = files('', jsonl(event(id(1), '2026-10-05T20:00:00Z')));
  const result = runScript('--master', paths.master, '--incoming', paths.incoming, '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).added, 1);
  assert.equal(readFileSync(paths.master, 'utf8'), '');
});

test('a refusal writes nothing to the master', () => {
  const master = jsonl(event(id(1), '2026-10-05T20:00:00Z'));
  const paths = files(master, jsonl(event(id(2), '2026-10-05T22:00:00Z'), '{"truncated'));
  const result = runScript('--master', paths.master, '--incoming', paths.incoming);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /line 2 is not valid JSON/);
  assert.equal(readFileSync(paths.master, 'utf8'), master);
});

test('a missing master or a missing argument is refused', () => {
  const paths = files('', '');
  const missing = runScript('--master', `${paths.master}.nope`, '--incoming', paths.incoming);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no such file/);
  const noArg = runScript('--incoming', paths.incoming);
  assert.equal(noArg.status, 1);
  assert.match(noArg.stderr, /--master <events.jsonl> is required/);
});
