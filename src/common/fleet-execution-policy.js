import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

const PATH = 'C:/Alpha/memory/local/device-execution-policy.json';
// Roles the owner has granted. 'cpu-capped-gpu-demand' (owner instruction
// 2026-10-17) keeps GPU and Singing on queued demand and also lends capped CPU.
// An unknown role still refuses to start: the file is the owner's word.
const ROLES = new Set(['gpu-demand-only', 'cpu-capped-gpu-demand']);
export function fleetExecutionPolicy({ path = PATH, platform = process.platform,
  machine = hostname(), read = readFileSync } = {}) {
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
  if (targets.length !== 1 || typeof targets[0] !== 'string' || !targets[0].trim()) {
    throw new Error('Owner GPU execution identity is invalid or ambiguous');
  }
  const isCpuHost = typeof data.cpu_host === 'string' && data.cpu_host.toLowerCase() === machine.toLowerCase();
  if (isCpuHost && (typeof data.cpu_agent_name !== 'string' || !data.cpu_agent_name.trim())) {
    throw new Error('Owner CPU execution identity invalid');
  }
  return { gpuAgent: targets[0], cpuAgent: isCpuHost ? data.cpu_agent_name : null };
}

