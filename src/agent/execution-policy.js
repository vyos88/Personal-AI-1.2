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

export function assertGeneralWorkerAllowed(options) {
  if (readExecutionPolicy(options)) {
    throw new Error('Owner execution-policy.json: CPU work belongs on the server; use the GPU demand controller');
  }
}

