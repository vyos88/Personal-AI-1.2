import os from 'node:os';

export const type = 'sysinfo';

export const description = 'Reports host machine vitals: platform, load, memory, uptime.';

export async function run() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    cpus: os.cpus().length,
    loadAverage: os.loadavg(),
    memory: { totalBytes: total, freeBytes: free, usedPercent: Math.round(((total - free) / total) * 100) },
    uptimeSeconds: Math.round(os.uptime()),
    nodeVersion: process.version,
  };
}
