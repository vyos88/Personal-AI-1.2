// The two reads that needed a person at the keyboard, pinned.
//
// Both come from real confusion on Worker1 on 2026-10-07: `awareness:
// not-started` read as a broken awareness loop when the assistant cycle simply
// had not been given the shared background lane, and "50 failures,
// evidence-contract" read as a broken agent fleet when the receipts carried the
// actual reason and nothing printed it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { homeAddress, summarizeReceipts, summarizeRuntime } from '../scripts/alpha-runtime.mjs';

test('the lane is reported, because a starved cycle looks exactly like a dead one', () => {
  // Alpha's own deck feed, as it answered at 23:04 on Worker1.
  const runtime = summarizeRuntime({
    runtime: { assistant: 'running', awareness: 'not-started', thoughts: 'active', heartbeat_age_s: 20 },
    freshness: {
      stale: false,
      waiting_on: 'background lane',
      waiting_since: '2026-10-07T23:00:55.308651',
      cycle_step: null,
      advice: 'feed live - waiting: background lane',
    },
  });
  assert.equal(runtime.assistant, 'running');
  assert.equal(runtime.awareness, 'not-started');
  // The two facts that turn that pair into a diagnosis rather than a mystery.
  assert.equal(runtime.waitingOn, 'background lane');
  assert.equal(runtime.waitingSince, '2026-10-07T23:00:55.308651');
  assert.equal(runtime.stale, false);
});

test('a feed with nothing waiting says so rather than inventing a lane', () => {
  const runtime = summarizeRuntime({ runtime: { assistant: 'running', awareness: '2026-10-08T00:50:00' }, freshness: {} });
  assert.equal(runtime.waitingOn, null);
  assert.equal(runtime.awareness, '2026-10-08T00:50:00');
  // A feed that did not answer at all must not read as a healthy fleet.
  assert.deepEqual(summarizeRuntime(null), {
    assistant: null, awareness: null, thoughts: null, heartbeatAgeS: null,
    waitingOn: null, waitingSince: null, cycleStep: null, stale: null, advice: null,
  });
});

test('receipts are reported with the reason, not only the class', () => {
  const registry = {
    agents: [
      {
        name: 'Coding Fixer',
        role: 'fixer',
        history: [
          {
            recorded_at: '2026-10-07T23:02:00',
            status: 'incomplete',
            failure_class: 'evidence-contract',
            reason: 'the output is missing required heading(s): ROLLBACK, TESTS',
          },
          {
            recorded_at: '2026-10-07T22:30:00',
            status: 'incomplete',
            failure_class: 'evidence-contract',
            // The manager fills a blocker from error when reason is absent.
            error: 'a scheduled run with no evidence packet must declare EVIDENCE: NONE and this output does not',
          },
        ],
      },
      {
        name: 'Chat Qc',
        role: 'qc',
        history: [{ recorded_at: '2026-10-07T21:00:00', status: 'completed', outcome: 'success' }],
      },
    ],
  };

  const summary = summarizeReceipts(registry, 3);
  assert.equal(summary.total, 3);
  // Classes are still counted — that is the deck's view — but the rows carry
  // what to change, which is the half that was missing.
  assert.deepEqual(summary.classes, [['evidence-contract', 2]]);
  assert.equal(summary.newest[0].agent, 'Coding Fixer');
  assert.match(summary.newest[0].reason, /missing required heading\(s\): ROLLBACK, TESTS/);
  assert.match(summary.newest[1].reason, /must declare EVIDENCE: NONE/);
  // A successful receipt has no class and no reason, and is not counted as one.
  assert.equal(summary.newest[2].failureClass, null);
  assert.equal(summary.newest[2].reason, '');

  // Newest first, whatever order the registry holds them in.
  assert.deepEqual(summary.newest.map((row) => row.at), [
    '2026-10-07T23:02:00', '2026-10-07T22:30:00', '2026-10-07T21:00:00',
  ]);
  // A registry with no agents is empty, not a crash.
  assert.deepEqual(summarizeReceipts({}, 3), { total: 0, classes: [], newest: [] });
});

test('the feed is asked on a LAN address, never on the tailnet', () => {
  // The deck feed is served to private-LAN clients only, so a 100.x address is
  // the one answer that cannot be right.
  assert.equal(
    homeAddress({
      tailscale0: [{ family: 4, internal: false, address: '100.69.243.25' }],
      wifi: [{ family: 4, internal: false, address: '192.168.2.151' }],
    }),
    '192.168.2.151',
  );
  // Nothing private at all: loopback, which is where the backend also answers.
  assert.equal(homeAddress({ lo: [{ family: 4, internal: true, address: '127.0.0.1' }] }), '127.0.0.1');
});

// On Windows URL.pathname is "/C:/...", which never equals the resolved argv
// path, so a guard built on it skips main() and exits 0 having printed nothing.
// That is what 20261008-02-alpha-runtime did on Laptop41: "->  0", empty output.
test('no script decides it was run directly from URL.pathname', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = new URL('../scripts/', import.meta.url);
  const offenders = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.mjs')) continue;
    const source = await readFile(new URL(name, dir), 'utf8');
    if (/new URL\(import\.meta\.url\)\.pathname/.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
