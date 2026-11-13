import test from 'node:test';
import assert from 'node:assert/strict';

import { fleetExecutionPolicy } from '../src/common/fleet-execution-policy.js';

// Owner request 2026-11-07: GPU targets stay always available with zero idle
// timeout. A queued-demand or idle-teardown policy is refused.
function policy(workerIdleSeconds = 0, workerMode = 'always-available') {
  return JSON.stringify({
    schema: 1,
    devices: {
      laptop: {
        role: 'gpu-demand-only', gpu_agent_name: 'Worker2RTX',
        gpu_mode: workerMode, idle_seconds: workerIdleSeconds,
      },
      jack: {
        role: 'gpu-demand-only', gpu_agent_name: 'JackRTX3050',
        gpu_mode: 'queued-demand', idle_seconds: 30,
      },
    },
    cpu_host: 'alpha-serv-01', cpu_agent_name: 'AlphaServer',
  });
}

function run(text, requestedGpuAgent) {
  return fleetExecutionPolicy({
    platform: 'win32', machine: 'alpha-serv-01', requestedGpuAgent,
    read: () => text,
  });
}

test('selects only the requested stable GPU target from a multi-target owner policy', () => {
  assert.deepEqual(run(policy(), 'Worker2RTX'), {
    gpuAgent: 'Worker2RTX', cpuAgent: 'AlphaServer',
  });
});

test('rejects the separately restricted Jack fallback for the image bridge', () => {
  assert.throws(() => run(policy(), 'JackRTX3050'), /not allowlisted/);
});

test('requires the selected GPU target to stay always-available with zero idle timeout', () => {
  assert.throws(() => run(policy(30), 'Worker2RTX'), /always-available with zero idle timeout/);
  assert.throws(() => run(policy(0, 'queued-demand'), 'Worker2RTX'), /always-available with zero idle timeout/);
});

test('keeps ambiguous no-target policy fail-closed', () => {
  assert.throws(() => run(policy()), /invalid or ambiguous/);
});