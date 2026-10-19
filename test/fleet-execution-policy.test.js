// The owner's fleet file decides who runs CPU and GPU work. An unknown role
// must still stop the agent; a role the owner granted must not.
import test from 'node:test';
import assert from 'node:assert/strict';

import { fleetExecutionPolicy } from '../src/common/fleet-execution-policy.js';

function policy(...roles) {
  const devices = Object.fromEntries(roles.map((role, i) => [`d${i}`, {
    schema: 1, machine: 'LAPTOP', role, gpu_agent_name: 'Worker2RTX',
  }]));
  return JSON.stringify({ schema: 1, devices, cpu_host: 'alpha-serv-01', cpu_agent_name: 'AlphaServer' });
}

const run = (text, machine = 'alpha-serv-01') =>
  fleetExecutionPolicy({ platform: 'win32', machine, read: () => text });

test('accepts the cpu-capped role alongside gpu-demand-only', () => {
  assert.deepEqual(run(policy('gpu-demand-only', 'cpu-capped-gpu-demand')),
    { gpuAgent: 'Worker2RTX', cpuAgent: 'AlphaServer' });
});

test('still refuses a role the owner never granted', () => {
  assert.throws(() => run(policy('gpu-demand-only', 'general')), /Owner fleet role invalid/);
});

test('names no CPU agent on a machine that is not the CPU host', () => {
  assert.deepEqual(run(policy('cpu-capped-gpu-demand'), 'laptop'),
    { gpuAgent: 'Worker2RTX', cpuAgent: null });
});
