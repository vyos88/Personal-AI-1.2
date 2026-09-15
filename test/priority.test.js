import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { spawn } from 'node:child_process';

import {
  DEFAULT_TASK_PRIORITY,
  deprioritize,
  priorityValue,
  renderThreadsFromEnv,
  taskPriorityFromEnv,
} from '../src/agent/priority.js';

/**
 * What a running task is allowed to take from the machine it landed on.
 *
 * Every other guard in this repo is about placement — whether work should
 * *start* here. None of them says anything about the ten minutes afterwards,
 * which is the whole of what the machine's owner experiences.
 */

// ------------------------------------------------------------ reading the env

test('the default priority is below normal, and lower than normal really is lower', () => {
  assert.equal(taskPriorityFromEnv(undefined), DEFAULT_TASK_PRIORITY);
  assert.equal(taskPriorityFromEnv(''), DEFAULT_TASK_PRIORITY);
  assert.equal(taskPriorityFromEnv('   '), DEFAULT_TASK_PRIORITY);

  // Nice values run the other way: a larger number is a weaker claim on the
  // CPU. Asserting the ordering rather than the constants means this still
  // holds if Node ever renumbers them.
  assert.ok(priorityValue('below_normal') > priorityValue('normal'));
  assert.ok(priorityValue('low') > priorityValue('below_normal'));
});

test('the priority name is forgiving about spelling but not about meaning', () => {
  for (const spelling of ['below_normal', 'below-normal', 'BELOW NORMAL', ' Below_Normal ']) {
    assert.equal(taskPriorityFromEnv(spelling), 'below_normal', spelling);
  }
  // `idle` and `low` are the same thing under two names people both type.
  assert.equal(priorityValue('idle'), priorityValue('low'));

  // A typo must not silently mean "normal". The setting exists precisely so
  // nobody has to notice their laptop is being taken over, so a misspelling
  // that quietly restored the old behaviour would be invisible until someone
  // complained about their screen again.
  assert.throws(() => taskPriorityFromEnv('belownormal'), /must be one of/);
  assert.throws(() => taskPriorityFromEnv('nice'), /must be one of/);
});

test('off leaves the child wherever it was, for a box with no desktop to protect', () => {
  assert.equal(taskPriorityFromEnv('off'), 'off');
  assert.equal(priorityValue('off'), null);
});

// -------------------------------------------------------------- thread budget

test('a render is capped a core short of the machine', () => {
  assert.equal(renderThreadsFromEnv(undefined, 8), 7);
  assert.equal(renderThreadsFromEnv(undefined, 4), 3);
  // One core is all there is; capping to zero would mean "all of them", which
  // is the opposite of what the floor is for.
  assert.equal(renderThreadsFromEnv(undefined, 1), 1);
  // A machine whose core count could not be read is treated as a single-core
  // one rather than producing a negative budget.
  assert.equal(renderThreadsFromEnv(undefined, 0), 1);

  assert.equal(renderThreadsFromEnv('2', 8), 2);
  // 0 is Blender's own "use what you find", and the honest way for a dedicated
  // render box to say it does not need the headroom.
  assert.equal(renderThreadsFromEnv('0', 8), 0);

  assert.throws(() => renderThreadsFromEnv('-1', 8), /between 0 and 1024/);
  assert.throws(() => renderThreadsFromEnv('2.5', 8), /between 0 and 1024/);
  assert.throws(() => renderThreadsFromEnv('all', 8), /between 0 and 1024/);
});

// ------------------------------------------------- doing it to a real process

/** A child that stays alive long enough to be asked about. */
function napping(t) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  return child;
}

test('a spawned child really ends up below the process that spawned it', (t) => {
  const child = napping(t);

  const before = os.getPriority(child.pid);
  assert.equal(deprioritize(child, { level: 'below_normal' }), true);
  const after = os.getPriority(child.pid);

  // Measured against the real scheduler rather than against the argument we
  // passed: lowering a priority is always permitted (it is raising one that
  // needs privileges), so this is not a check that can only pass as root.
  assert.ok(after > before, `expected the child to be niced: ${before} -> ${after}`);
  assert.ok(after > os.getPriority(process.pid), 'the child outranks nothing, including us');
});

test('off is a no-op rather than a reset to normal', (t) => {
  const child = napping(t);
  const before = os.getPriority(child.pid);
  assert.equal(deprioritize(child, { level: 'off' }), false);
  assert.equal(os.getPriority(child.pid), before);
});

test('lowering a priority is advisory, so failing to do it never fails the task', () => {
  // A spawn that failed outright has no pid, and this is reached from inside
  // the error path of whatever went wrong — throwing here would replace a
  // useful "Blender not found" with a TypeError about `pid`.
  assert.doesNotThrow(() => deprioritize(null));
  assert.doesNotThrow(() => deprioritize({}));
  assert.equal(deprioritize(undefined), false);

  // A process that exited between spawn and here is ESRCH, and a hardened
  // policy is EPERM. Both are logged and swallowed.
  const logged = [];
  const gone = { pid: 0x7ffffffe };
  assert.equal(deprioritize(gone, { log: { debug: (m, d) => logged.push([m, d]) } }), false);
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /could not lower the priority/);
});
