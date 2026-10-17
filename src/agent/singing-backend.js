import { spawn, execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';

// Only this session's child is owned. An unknown queue is never idle.
export function createSingingBackend({ root, script, stateRoot, bind, idleMs = 30_000, log = () => {} }) {
  let child, exited, ready = false, key;
  async function json(path) {
    const response = await fetch(`http://${bind}:8003${path}`, {
      headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Singing HTTP ${response.status}`);
    return (await response.json()).data;
  }
  return {
    async ensure(signal) {
      if (ready) return;
      try { await json('/health'); throw new Error('Singing already runs outside this session'); }
      catch (error) { if (error.message.includes('outside this session')) throw error; }
      const engineRoot = await realpath(root);
      const python = await realpath(join(engineRoot, 'ACE-Step-1.5', '.venv', 'Scripts', 'python.exe'));
      key = (await readFile(join(engineRoot, 'music-singing-key.txt'), 'utf8')).trim();
      if (!key) throw new Error('Singing credential is empty');
      const fd = openSync(join(stateRoot, 'singing-on-demand.log'), 'a');
      let failure;
      try {
        child = spawn(python, [script], { cwd: engineRoot, windowsHide: true,
          detached: process.platform !== 'win32', stdio: ['ignore', fd, fd], env: {
            ...process.env, ALPHA_SINGING_ROOT: engineRoot, ALPHA_SINGING_BIND: bind,
            ALPHA_SINGING_ACTIVITY: join(stateRoot, 'singing-activity.json'),
            ACESTEP_API_KEY: key, ACESTEP_CONFIG_PATH: 'acestep-v15-turbo',
            ACESTEP_INIT_LLM: 'false', ACESTEP_DEVICE: 'cuda', ACESTEP_LM_BACKEND: 'pt',
            // The installed 4 GiB CUDA profile stages weights in RAM between
            // GPU calls. This is part of the GPU job, not a CPU worker offer.
            ACESTEP_OFFLOAD_TO_CPU: 'true', ACESTEP_OFFLOAD_DIT_TO_CPU: 'true',
            ACESTEP_VAE_ON_CPU: 'false', ACESTEP_USE_FLASH_ATTENTION: 'false',
            ACESTEP_COMPILE_MODEL: 'false', ACESTEP_QUEUE_WORKERS: '1',
            ACESTEP_QUEUE_MAXSIZE: '2', ACESTEP_DOWNLOAD_SOURCE: 'huggingface',
            ACESTEP_NO_INIT: 'false', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1',
            PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
          } });
      } finally { closeSync(fd); }
      exited = new Promise((done) => {
        child.once('error', (error) => { failure = error; done(); }); child.once('exit', done);
      });
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw signal.reason;
        if (failure) throw failure;
        if (child.exitCode !== null) throw new Error(`Singing exited ${child.exitCode}; inspect singing-on-demand.log`);
        try {
          const health = await json('/health');
          if (health.service === 'ACE-Step API' && health.models_initialized === true) {
            const runtime = await json('/alpha/runtime');
            if (!runtime.cuda_available || !runtime.device.startsWith('cuda')) {
              throw new Error('Singing runtime did not select CUDA');
            }
            ready = true; log({ state: 'singing-ready', device: 'cuda', ramStaging: runtime.cpu_offload }); return;
          }
        } catch (error) {
          if (error.message.includes('did not select CUDA')) throw error;
          // Startup has not bound yet.
        }
        await new Promise((done) => setTimeout(done, 1000));
      }
      throw new Error('Singing CUDA startup timed out');
    },
    async busy() {
      if (!child || child.exitCode !== null || !ready) return false;
      try {
        const stats = await json('/v1/stats');
        const activity = JSON.parse(await readFile(join(stateRoot, 'singing-activity.json'), 'utf8'));
        return stats.jobs.running > 0 || stats.jobs.queued > 0 || stats.queue_size > 0
          || activity.active > 0 || Date.now() - activity.lastActivity * 1000 < idleMs;
      } catch { return true; }
    },
    async stop() {
      if (!child?.pid || child.exitCode !== null) { ready = false; return; }
      if (process.platform === 'win32') await new Promise((done, reject) => execFile(
        join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true },
        (error) => error && child.exitCode === null ? reject(error) : done()));
      else process.kill(-child.pid, 'SIGTERM');
      await exited; ready = false; log({ state: 'singing-stopped' });
    },
  };
}
