import test from 'node:test';
import assert from 'node:assert/strict';

import { fleetExecutionPolicy } from '../src/common/fleet-execution-policy.js';

function policy(workerIdleSeconds = 30) {
  return JSON.stringify({
    schema: 1,
    devices: {
      laptop: {
        role: 'gpu-demand-only', gpu_agent_name: 'Worker2RTX',
        gpu_mode: 'queued-demand', idle_seconds: workerIdleSeconds,
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

test('requires the selected GPU role to remain queued-demand with 30-second teardown', () => {
  assert.throws(() => run(policy(60), 'Worker2RTX'), /queued-demand with 30-second/);
});

test('keeps ambiguous no-target policy fail-closed', () => {
  assert.throws(() => run(policy()), /invalid or ambiguous/);
});