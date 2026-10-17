#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { open, readFile, unlink, realpath } from 'node:fs/promises';
import { openSync, closeSync, existsSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { freemem } from 'node:os';
import { resolveExecutable } from '../src/common/resolve-executable.js';
import { runGpuDemand } from '../src/agent/gpu-demand.js';
import { createSingingBackend } from '../src/agent/singing-backend.js';
import { readExecutionPolicy } from '../src/agent/execution-policy.js';

export async function main(argv = process.argv.slice(2)) {
const { values } = parseArgs({ args: argv, options: { 'env-file': { type: 'string' } } });
if (!values['env-file']) throw new Error('--env-file is required');
process.loadEnvFile(resolve(values['env-file']));
const ownerPolicy = readExecutionPolicy();
if (ownerPolicy) {
 if (!ownerPolicy.gpu_agent_name || !Number.isFinite(ownerPolicy.idle_seconds) || ownerPolicy.idle_seconds <= 0) throw new Error('Owner GPU policy invalid');
 process.env.ALPHA_AGENT_NAME = ownerPolicy.gpu_agent_name;
 process.env.ALPHA_GPU_IDLE_MS = String(ownerPolicy.idle_seconds * 1000);
}
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stateRoot = resolve(process.env.ALPHA_GPU_STATE_DIR ?? '.');
const lockPath = join(stateRoot, 'gpu-demand.lock');
let lock;
try { lock = await open(lockPath, 'wx'); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const oldPid = Number((await readFile(lockPath, 'utf8')).trim());
  if (!Number.isInteger(oldPid) || oldPid < 1) throw new Error('GPU lock is invalid; inspect it before removing it');
  try { process.kill(oldPid, 0); process.exit(0); }
  catch (check) { if (check.code !== 'ESRCH') process.exit(0); }
  await unlink(lockPath);
  // A competing stale-lock recovery may win. It owns this pass in that case.
  try { lock = await open(lockPath, 'wx'); }
  catch (check) { if (check.code === 'EEXIST') process.exit(0); throw check; }
}
await lock.writeFile(String(process.pid));
const log = (event) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => abort.abort());

// This controller owns only the ComfyUI process it starts. The old restart-loop
// launcher remains disabled; adopting or killing someone else's backend is unsafe.
let comfyChild;
let comfyExit;
let comfyReady;
async function comfyJson(path, timeoutMs = 3_000) {
  const response = await fetch(`http://127.0.0.1:8188${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`ComfyUI ${path}: HTTP ${response.status}`);
  return response.json();
}
const imageBackend = {
  async ensure(signal) {
    if (comfyReady) return;
    try { await comfyJson('/system_stats'); throw new Error('ComfyUI is already running outside this GPU session'); }
    catch (error) { if (error.message.includes('outside this GPU session')) throw error; }
    const comfyRoot = await realpath(process.env.ALPHA_GPU_COMFY_ROOT ?? 'C:/services/ComfyUI');
    const script = await realpath(join(comfyRoot, 'main.py'));
    if (!script.startsWith(comfyRoot + sep)) throw new Error('ComfyUI main.py must stay inside its configured root');
    const python = await realpath(join(comfyRoot, 'venv', 'Scripts', 'python.exe'));
    const fd = openSync(join(stateRoot, 'comfy-on-demand.log'), 'a');
    try {
      comfyChild = spawn(python, [script, '--listen', '127.0.0.1', '--port', '8188', '--lowvram'],
        { cwd: comfyRoot, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd] });
    } finally { closeSync(fd); }
    let spawnError;
    comfyExit = new Promise((done) => {
      comfyChild.once('error', (error) => { spawnError = error; done(); });
      comfyChild.once('exit', done);
    });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason;
      if (spawnError) throw spawnError;
      if (comfyChild.exitCode !== null) throw new Error(`ComfyUI exited ${comfyChild.exitCode}; inspect comfy-on-demand.log`);
      try {
        const stats = await comfyJson('/system_stats');
        if (!stats.devices?.some((device) => device.type === 'cuda')) throw new Error('ComfyUI did not select CUDA');
        comfyReady = true;
        log({ state: 'gpu-backend-ready', devices: stats.devices.map(({ name, type }) => ({ name, type })) });
        return;
      } catch (error) { if (error.message.includes('select CUDA')) throw error; }
      await new Promise((done) => setTimeout(done, 1_000));
    }
    throw new Error('ComfyUI startup timed out; inspect comfy-on-demand.log');
  },
  async busy() {
    if (!comfyChild || comfyChild.exitCode !== null || !comfyReady) return false;
    try {
      const queue = await comfyJson('/queue');
      return Boolean(queue.queue_running?.length || queue.queue_pending?.length);
    } catch { return true; } // Unknown is not idle.
  },
  async stop() {
    if (!comfyChild?.pid || comfyChild.exitCode !== null) return;
    // runGpuDemand has drained all leases and checked the local generator queue.
    if (process.platform === 'win32') {
      await new Promise((done, reject) => execFile(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(comfyChild.pid), '/T', '/F'], { windowsHide: true }, (error) => {
          if (error && comfyChild.exitCode === null) reject(error); else done();
        }));
    } else process.kill(-comfyChild.pid, 'SIGTERM');
    await comfyExit;
    log({ state: 'gpu-backend-stopped' });
  },
};

const singingBackend = createSingingBackend({
  root: process.env.ALPHA_GPU_SINGING_ROOT ?? 'C:/AlphaSinging',
  script: join(root, 'scripts', 'run-singing-demand.py'), stateRoot,
  bind: process.env.ALPHA_GPU_SINGING_BIND ?? '100.93.104.24',
  idleMs: Number(process.env.ALPHA_GPU_IDLE_MS ?? 30_000), log,
});
async function handOver(backend, signal) {
  while (await backend.busy()) {
    if (signal?.aborted) throw signal.reason;
    await new Promise((done) => setTimeout(done, 1000));
  }
  await backend.stop();
}
const backends = {
  async ensure(signal) { await handOver(singingBackend, signal); await imageBackend.ensure(signal); },
  async busy() { return await imageBackend.busy() || await singingBackend.busy(); },
  async stop() { await singingBackend.stop(); await imageBackend.stop(); },
};

try {
  const handlers = [];
  handlers.push({ type: 'alpha.singing.wake', async run(payload, { signal }) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length) {
      throw new Error('Singing wake takes an empty object only');
    }
    await handOver(imageBackend, signal);
    await singingBackend.ensure(signal);
    return { ready: true, device: 'cuda', ramStaging: true };
  } });
  for (const name of ['alpha-render', 'alpha-render-inventory', 'alpha-image', 'alpha-image-file']) {
    const path = join(root, 'src', 'agent', 'handlers', `${name}.js`);
    if (!existsSync(path)) continue;
    const handler = await import(new URL(`../src/agent/handlers/${name}.js`, import.meta.url));
    const availability = handler.available?.() ?? { ok: true };
    if (availability.ok) handlers.push(handler);
    else log({ state: 'handler-unavailable', type: handler.type, reason: availability.reason });
  }
  await runGpuDemand({
    hostUrl: process.env.ALPHA_HOST_URL, queueToken: process.env.ALPHA_GPU_QUEUE_TOKEN,
    workerToken: process.env.ALPHA_AGENT_KEY, name: process.env.ALPHA_AGENT_NAME,
    handlers, imageBackend: backends, signal: abort.signal,
    async canStart() {
      const reserve = Number(process.env.ALPHA_AGENT_MEMORY_RESERVE_MB ?? 2048) * 1024 ** 2;
      if (freemem() < reserve + 1024 ** 2 * 1024) return { ok: false, reason: 'Need 1 GiB free above the configured RAM reserve' };
      const binary = resolveExecutable('nvidia-smi');
      if (!binary) return { ok: false, reason: 'NVIDIA GPU probe unavailable' };
      const free = await new Promise((done, reject) => execFile(binary,
        ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 5_000 },
        (error, output) => error ? reject(error) : done(Number(output.trim().split('\n')[0]))));
      return free >= 512 ? { ok: true } : { ok: false, reason: 'Need at least 512 MiB free GPU memory' };
    },
    idleMs: Number(process.env.ALPHA_GPU_IDLE_MS ?? 30_000),
    maxLoad: Number(process.env.ALPHA_AGENT_MAX_LOAD ?? 0.85),
    memoryReserveBytes: Number(process.env.ALPHA_AGENT_MEMORY_RESERVE_MB ?? 2048) * 1024 ** 2,
    log,
  });
} finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
