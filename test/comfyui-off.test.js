import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/comfyui-off.ps1 needs PowerShell. Set PWSH to its path, or have
// pwsh on PATH; without it these tests are skipped, not failed.
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const skip = hasPwsh ? false : 'PowerShell not found (set PWSH)';
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'comfyui-off.ps1');
const SECRET = 'alpha_key_fedcba9876543210fedcba9876543210';

const pwsh = (...args) => spawnSync(PWSH, ['-NoProfile', '-File', SCRIPT, ...args], { encoding: 'utf8' });

// Worker1, 2026-10-07: its ComfyUI held 3.4 GB with about 1 GB free.
test('only ComfyUI goes, from its own launcher up, never a parent that does not name it', { skip, timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'comfyui-off-'));
  const file = join(dir, 'procs.json');
  const py = (pid, parent, cmd, mb = 50) => ({ pid, parent, name: 'python.exe', cmd, mb });
  writeFileSync(file, JSON.stringify([
    { pid: 4, parent: 0, name: 'System', cmd: '', mb: 1 },
    { pid: 900, parent: 4, name: 'explorer.exe', cmd: 'C:\\Windows\\explorer.exe', mb: 200 },
    // Worker1's, started by hand from explorer.
    py(15724, 900, '"C:\\Users\\Vyo\\ComfyUI\\venv\\Scripts\\python.exe" main.py --port 8188 --listen 127.0.0.1', 3473),
    // start-comfyui.ps1's restart loop, with its python under it.
    { pid: 300, parent: 900, name: 'powershell.exe', cmd: 'powershell.exe -File C:\\services\\alpha-tunnel\\scripts\\start-comfyui.ps1 -ComfyDir C:\\services\\ComfyUI', mb: 60 },
    py(301, 300, 'C:\\services\\ComfyUI\\venv\\Scripts\\python.exe C:\\services\\ComfyUI\\main.py --listen 127.0.0.1 --port 8188', 2000),
    // Alpha's backend and its ComfyUI bridge on 7860 stay.
    { pid: 100, parent: 900, name: 'cmd.exe', cmd: 'cmd.exe /c "C:\\ProgramData\\AlphaBoot\\run-alpha-backend.cmd"', mb: 3 },
    py(101, 100, '"C:\\Users\\Vyo\\Downloads\\VyoS-advance-tech-ai\\.venv\\Scripts\\python.exe" main.py', 3000),
    py(16876, 900, '"C:\\A\\.venv\\Scripts\\python.exe" C:\\A\\scripts\\alpha_comfyui_bridge.py', 8),
  ]));
  const r = pwsh('-ProcessesJson', file);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(plan.stop.map((s) => s.pid).sort((a, b) => a - b), [300, 15724], 'the loop that would restart it goes with it; explorer stays');
  assert.equal(plan.stop.find((s) => s.pid === 300).processes, 2);
  assert.equal(plan.mb, 3473 + 60 + 2000);
});

test('the image handlers come out of the agent, everything else stays', { skip, timeout: 60_000 }, () => {
  const repo = mkdtempSync(join(tmpdir(), 'comfyui-off-'));
  const envFile = join(repo, '.env.agent');
  writeFileSync(envFile, `ALPHA_AGENT_KEY=${SECRET}\nALPHA_EXTRA_HANDLERS=alpha-coordination,alpha-music,alpha-image,alpha-music-audio,alpha-image-file\nALPHA_IMAGE_BACKEND=comfyui\n`);
  const r = pwsh('-Repo', repo, '-NoRestart');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(SECRET.slice(10)));
  const text = readFileSync(envFile, 'utf8');
  assert.match(text, /^ALPHA_EXTRA_HANDLERS=alpha-coordination,alpha-music,alpha-music-audio$/m);
  assert.match(text, new RegExp(`^ALPHA_AGENT_KEY=${SECRET}$`, 'm'));
  assert.match(text, /^ALPHA_IMAGE_BACKEND=comfyui$/m);
  // Running it again changes nothing.
  assert.equal(pwsh('-Repo', repo, '-NoRestart').status, 0);
  assert.equal(readFileSync(envFile, 'utf8'), text);
});
