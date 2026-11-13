import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

// This is an owner-set machine file, never an inherited environment override.
export const POLICY_PATH = 'C:/ProgramData/Alpha/execution-policy.json';

export function readExecutionPolicy({ path = POLICY_PATH, platform = process.platform,
  machine = hostname(), read = readFileSync } = {}) {
  if (platform !== 'win32') return;
  let text;
  try { text = read(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let policy;
  try { policy = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Owner execution policy is invalid; general worker refused'); }
  if (policy.schema !== 1 || policy.role !== 'gpu-demand-only'
      || policy.machine?.toLowerCase() !== machine.toLowerCase()) {
    throw new Error('Owner execution policy does not match this machine; general worker refused');
  }
  return policy;
}

// How long the GPU worker stays registered after its last job. The owner's
// policy (2026-11-07) is gpu_mode 'always-available' with idle_seconds 0: no
// idle teardown at all, so the worker and its GPU backends stay up (Infinity).
// A positive idle_seconds keeps the older timed teardown. Anything else is
// refused rather than guessed.
export function ownerGpuIdleMs(policy) {
  if (policy?.gpu_mode === 'always-available' && policy.idle_seconds === 0) return Infinity;
  if (policy?.gpu_mode === 'always-available') {
    throw new Error('Owner GPU policy invalid: always-available requires idle_seconds 0');
  }
  if (!Number.isFinite(policy?.idle_seconds) || policy.idle_seconds <= 0) {
    throw new Error('Owner GPU identity/idle policy is invalid; inspect execution-policy.json');
  }
  return policy.idle_seconds * 1000;
}

export function assertGeneralWorkerAllowed(options) {
  if (readExecutionPolicy(options)) {
    throw new Error('Owner execution-policy.json: CPU work belongs on the server; use the GPU demand controller');
  }
}

