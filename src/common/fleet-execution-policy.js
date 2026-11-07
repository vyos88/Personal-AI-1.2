import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

const PATH = 'C:/Alpha/memory/local/device-execution-policy.json';
// Accept only roles that the owner has granted. An unknown role stops the
// worker instead of widening its capabilities.
const ROLES = new Set(['gpu-demand-only', 'cpu-capped-gpu-demand']);
// The image bridge uses a stable, owner-allowlisted target rather than an
// arbitrary machine from the fleet.
const STABLE_GPU_TARGETS = new Set(['AlphaServer', 'Worker2RTX']);
export function fleetExecutionPolicy({ path = PATH, platform = process.platform,
  machine = hostname(), read = readFileSync,
  requestedGpuAgent = undefined } = {}) {
  if (platform !== 'win32') return null;
  let raw;
  try { raw = read(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (data.schema !== 1 || !data.devices || typeof data.devices !== 'object'
      || Array.isArray(data.devices)) throw new Error('Owner fleet execution policy invalid');
  const policies = Object.values(data.devices);
  if (policies.some((p) => !p || !ROLES.has(p.role))) throw new Error('Owner fleet role invalid');
  const targets = [...new Set(policies.map((p) => p.gpu_agent_name))];
  if (targets.some((target) => typeof target !== 'string' || !target.trim())) {
    throw new Error('Owner GPU execution identity is invalid or ambiguous');
  }
  let gpuAgent;
  if (requestedGpuAgent === undefined) {
    if (targets.length !== 1 || !STABLE_GPU_TARGETS.has(targets[0])) {
      throw new Error('Owner GPU execution identity is invalid or ambiguous');
    }
    gpuAgent = targets[0];
  } else {
    if (typeof requestedGpuAgent !== 'string' || !requestedGpuAgent.trim()) {
      throw new Error('Owner GPU target is missing or invalid');
    }
    if (!STABLE_GPU_TARGETS.has(requestedGpuAgent)) {
      throw new Error('Owner GPU target is not allowlisted');
    }
    gpuAgent = requestedGpuAgent;
  }
  const selected = policies.filter((p) => p.gpu_agent_name === gpuAgent);
  if (!selected.length) throw new Error('Owner GPU target is absent from the protected policy');
  if (selected.some((p) => p.gpu_mode !== 'always-available' || p.idle_seconds !== 0)) {
    throw new Error('Owner GPU target must remain always-available with zero idle timeout');
  }
  const isCpuHost = typeof data.cpu_host === 'string' && data.cpu_host.toLowerCase() === machine.toLowerCase();
  let cpuAgent = null;
  if (isCpuHost) {
    if (data.cpu_agent_name === undefined) {
      cpuAgent = 'AlphaServer';
    } else if (typeof data.cpu_agent_name !== 'string' || !data.cpu_agent_name.trim()) {
      throw new Error('Owner CPU execution identity invalid');
    } else {
      cpuAgent = data.cpu_agent_name.trim();
    }
  }
  return { gpuAgent, cpuAgent };
}

