import test from 'node:test';
import assert from 'node:assert/strict';
import { singingBusy } from '../src/agent/singing-backend.js';

const idle = { jobs: { running: 0, queued: 0 }, queue_size: 0 };
test('Singing sleeps after real work and request grace finish', () => {
  assert.equal(singingBusy(idle, { active: 0, lastActivity: 100 }, 130000), false);
  assert.equal(singingBusy(idle, { active: 0, lastActivity: 100 }, 129999), true);
});
test('a live stream or engine generation prevents shutdown', () => {
  assert.equal(singingBusy(idle, { active: 1, lastActivity: 100 }, 200000), true);
  for (const stats of [{ ...idle, jobs: { running: 1, queued: 0 } }, { ...idle, queue_size: 1 }]) {
    assert.equal(singingBusy(stats, { active: 0, lastActivity: 100 }, 200000), true);
  }
});
test('missing, malformed or future activity is not read as idle', () => {
  for (const activity of [undefined, {}, { active: -1, lastActivity: 100 }, { active: '0', lastActivity: 100 }, { active: 0, lastActivity: NaN }, { active: 0, lastActivity: 300 }]) {
    assert.equal(singingBusy(idle, activity, 200000), true);
  }
  assert.equal(singingBusy({}, { active: 0, lastActivity: 100 }, 200000), true);
});
