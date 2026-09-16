// The one scheduled check that a machine is still lending, and specifically
// the part that reads `/agents` back: which row is "this machine" when more
// than one row carries its name.
//
// Same-name machines are legal (fleet.test.js: "two machines under one name
// are two workers"), and so is a superseded registration lingering in the
// list until the stale sweep drops it. `pickLive` is what checkFleet uses to
// pick this machine's live row out of however many share its name — it has to
// agree with the freshest-heartbeat test that decides `attached`/`stale`, or
// the watchdog could report a dead process's version as this machine's while
// correctly calling the machine itself attached.
import test from 'node:test';
import assert from 'node:assert/strict';

import { pickLive } from '../scripts/watchdog.mjs';

test('among two rows sharing a name, the freshest heartbeat wins', () => {
  const agents = [
    { name: 'laptop', version: '0.2.1', idleMs: 65_000 }, // superseded, not yet swept
    { name: 'laptop', version: '0.3.0', idleMs: 500 }, // the process actually running now
    { name: 'other', version: '0.3.0', idleMs: 0 },
  ];
  assert.equal(pickLive(agents, 'laptop').version, '0.3.0');
});

test('order in the list does not decide it — the stale row can sort first', () => {
  const agents = [
    { name: 'laptop', version: '0.3.0', idleMs: 200 },
    { name: 'laptop', version: '0.2.1', idleMs: 90_000 },
  ];
  assert.equal(pickLive(agents, 'laptop').version, '0.3.0');
});

test('a name nothing answers to picks nothing', () => {
  assert.equal(pickLive([{ name: 'laptop', idleMs: 0 }], 'jacks-laptop'), null);
  assert.equal(pickLive([], 'laptop'), null);
});

test('a report missing idleMs is never mistaken for the freshest one', () => {
  // Same shape as the load/memory reads elsewhere in this codebase: an absent
  // figure ranks worse than a present one, not better.
  const agents = [
    { name: 'laptop', version: 'stale' },
    { name: 'laptop', version: 'current', idleMs: 1_000 },
  ];
  assert.equal(pickLive(agents, 'laptop').version, 'current');
});
