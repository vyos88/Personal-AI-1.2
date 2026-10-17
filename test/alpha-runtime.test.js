// The two reads that needed a person at the keyboard, pinned.
//
// Both come from real confusion on Worker1 on 2026-10-07: `awareness:
// not-started` read as a broken awareness loop when the assistant cycle simply
// had not been given the shared background lane, and "50 failures,
// evidence-contract" read as a broken agent fleet when the receipts carried the
// actual reason and nothing printed it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { describeShape, homeAddress, isEntrypoint, summarizeReceipts, summarizeRuntime } from '../scripts/alpha-runtime.mjs';

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
  // The shape `_load_agent_registry` writes: one flat `receipts` list beside
  // the roster, joined by `agent_id`. The derived `agents[].history` of
  // `_agent_runtime_view` exists only in an API response, never in the file.
  const registry = {
    schema_version: 5,
    agents: [
      { id: 'agent-coding-fixer', name: 'Coding Fixer', deck: 'coding' },
      { id: 'agent-chat-qc', name: 'Chat Qc', deck: 'chat' },
    ],
    receipts: [
      {
        agent_id: 'agent-coding-fixer',
        role: 'fixer',
        deck: 'coding',
        completed_at: '2026-10-07T23:02:00',
        status: 'incomplete',
        failure_class: 'evidence-contract',
        reason: 'the output is missing required heading(s): ROLLBACK, TESTS',
      },
      {
        agent_id: 'agent-coding-fixer',
        role: 'fixer',
        deck: 'coding',
        completed_at: '2026-10-07T22:30:00',
        status: 'incomplete',
        failure_class: 'evidence-contract',
        // The manager fills a blocker from error when reason is absent.
        error: 'a scheduled run with no evidence packet must declare EVIDENCE: NONE and this output does not',
      },
      {
        agent_id: 'agent-chat-qc',
        role: 'qc',
        completed_at: '2026-10-07T21:00:00',
        status: 'completed',
        outcome: 'success',
      },
    ],
  };

  const summary = summarizeReceipts(registry, 3);
  assert.equal(summary.total, 3);
  // Classes are still counted (that is the deck's view), but the rows carry
  // what to change, which is the half that was missing.
  assert.deepEqual(summary.classes, [['evidence-contract', 2]]);
  // An id alone sends nobody anywhere, so the roster name is joined on.
  assert.equal(summary.newest[0].agent, 'Coding Fixer');
  assert.match(summary.newest[0].reason, /missing required heading\(s\): ROLLBACK, TESTS/);
  assert.match(summary.newest[1].reason, /must declare EVIDENCE: NONE/);
  // A successful receipt has no class and no reason, and is not counted as one.
  assert.equal(summary.newest[2].agent, 'Chat Qc');
  assert.equal(summary.newest[2].failureClass, null);
  assert.equal(summary.newest[2].reason, '');

  // Newest first, whatever order the registry holds them in.
  assert.deepEqual(summary.newest.map((row) => row.at), [
    '2026-10-07T23:02:00', '2026-10-07T22:30:00', '2026-10-07T21:00:00',
  ]);
  // A receipt naming an agent the roster has lost still reports, by id.
  const orphan = summarizeReceipts({ agents: [], receipts: [{ agent_id: 'agent-gone', completed_at: '2026-10-07T20:00:00' }] });
  assert.equal(orphan.newest[0].agent, 'agent-gone');
});

test('an empty receipt list says whether the file was empty or misread', () => {
  // The bug this guards: reading `agents[].history` out of the file answered
  // "0 retained; classes none" from a registry holding two evidence-contract
  // failures, which reads as a healthy fleet rather than as a bug -- the
  // `alpha-devices.js` `serialPorts` mistake with a week of receipts behind it.
  const registry = {
    schema_version: 5,
    agents: [{ id: 'agent-coding-fixer', name: 'Coding Fixer' }],
    receipts: [
      { agent_id: 'agent-coding-fixer', completed_at: '2026-10-07T23:02:00', status: 'incomplete', failure_class: 'evidence-contract' },
    ],
  };
  assert.equal(summarizeReceipts(registry).total, 1);
  // The shape line is what makes the difference legible on the next pass: a
  // genuinely empty ledger names `receipts[0]`, a misread one names the key
  // that is actually there.
  assert.match(describeShape(registry), /receipts\[1\]/);
  assert.match(describeShape({ agents: [], receipts: [] }), /receipts\[0\]/);
  assert.match(describeShape({ agents: [{ id: 'a', history: [] }] }), /^agents\[1\]$/);

  // A registry with no receipts is empty, not a crash, and carries the shape.
  const empty = summarizeReceipts({}, 3);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.classes, []);
  assert.deepEqual(empty.newest, []);
  assert.equal(empty.shape, 'no keys');
  assert.equal(summarizeReceipts(null).shape, 'not an object');
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

test('the entrypoint guard survives the two spellings Windows gives one file', () => {
  // The first real pass of this script on Worker1 printed nothing and exited 0
  // in 0 seconds — the signature of a guard that answered no. On Windows the
  // same file reaches `argv[1]` and `import.meta.url` with different casing
  // (the ESM loader reports the on-disk spelling), and a case-sensitive string
  // comparison then hides the whole script behind a silent success.
  const url = 'file:///C:/services/alpha-tunnel/scripts/alpha-runtime.mjs';
  assert.equal(isEntrypoint('C:\\services\\alpha-tunnel\\scripts\\alpha-runtime.mjs', url, 'win32'), true);
  assert.equal(isEntrypoint('C:\\Services\\Alpha-Tunnel\\scripts\\alpha-runtime.mjs', url, 'win32'), true);
  // Still a real comparison: another file is not this one.
  assert.equal(isEntrypoint('C:\\services\\alpha-tunnel\\scripts\\panel-up.mjs', url, 'win32'), false);
  // Imported rather than run: no argv[1] at all.
  assert.equal(isEntrypoint(undefined, url, 'win32'), false);
  assert.equal(isEntrypoint('', url, 'win32'), false);

  // POSIX keeps its case sensitivity, because there `Scripts` and `scripts` are
  // two directories and treating them as one would be the opposite bug.
  const posix = 'file:///srv/alpha-tunnel/scripts/alpha-runtime.mjs';
  assert.equal(isEntrypoint('/srv/alpha-tunnel/scripts/alpha-runtime.mjs', posix, 'linux'), true);
  assert.equal(isEntrypoint('/srv/alpha-tunnel/Scripts/alpha-runtime.mjs', posix, 'linux'), false);
});

test('this file is reachable as a module without running main()', async () => {
  // The import at the top of this suite is the proof: importing the script must
  // not start a run, or every test here would make a network call.
  const module = await import('../scripts/alpha-runtime.mjs');
  assert.equal(typeof module.isEntrypoint, 'function');
  assert.equal(module.isEntrypoint(process.argv[1], 'file:///somewhere/else.mjs'), false);
});
