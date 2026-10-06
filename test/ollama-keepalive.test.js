import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';

// Ollama's own format: nanoseconds and a local offset, e.g. 2026-10-07T17:40:00.123456789+01:00.
const ollamaTime = (ms) => new Date(ms + 3600e3).toISOString().replace('Z', '').replace(/\.(\d{3})$/, '.$1456789') + '+01:00';

// scripts/ollama-keepalive.ps1 needs PowerShell. Set PWSH to its path, or have
// pwsh on PATH; without it these tests are skipped, not failed.
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const skip = hasPwsh ? false : 'PowerShell not found (set PWSH)';
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'ollama-keepalive.ps1');

// A stand-in Ollama: the model loads on /api/generate, and /api/ps says when
// it will be unloaded.
async function run(keptMinutes, extra = []) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${body}`);
      const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/tags') return json({ models: [{ name: 'llama3.2:3b' }] });
      if (req.url === '/api/generate') return json({ response: '', done: true, load_duration: 5e9 });
      if (req.url === '/api/ps') return json({ models: [{ name: 'llama3.2:3b', model: 'llama3.2:3b', expires_at: ollamaTime(Date.now() + keptMinutes * 60000) }] });
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const r = await new Promise((resolve) => {
    const p = spawn(PWSH, ['-NoProfile', '-File', SCRIPT, '-NoRestart', '-OllamaUrl', url, '-Model', 'llama3.2:3b', ...extra]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (status) => resolve({ status, out }));
  });
  server.close();
  return { ...r, seen };
}

test('loads the chat model and confirms Ollama keeps it', { skip, timeout: 120_000 }, async () => {
  const { status, out, seen } = await run(24 * 60);
  assert.equal(status, 0, out);
  assert.match(out, /set OLLAMA_KEEP_ALIVE=24h/);
  assert.match(out, /loaded 'llama3\.2:3b' in/);
  assert.match(out, /ok: 'llama3\.2:3b' is loaded and kept for 24 h after each use/);
  assert.ok(seen.some((s) => s.startsWith('POST /api/generate') && /"model":\s*"llama3\.2:3b"/.test(s)), seen.join('\n'));
});

test('a setting Ollama did not take is a failure, not a success', { skip, timeout: 120_000 }, async () => {
  const { status, out } = await run(5);
  assert.equal(status, 1, out);
  assert.match(out, /PROBLEM: Ollama will unload 'llama3\.2:3b' in 5 min/);
});

test('arguments that are not a duration or a model name are refused', { skip, timeout: 60_000 }, () => {
  const bad = spawnSync(PWSH, ['-NoProfile', '-File', SCRIPT, '-NoRestart', '-KeepAlive', '24h; calc'], { encoding: 'utf8' });
  assert.equal(bad.status, 2, bad.stdout);
  assert.match(bad.stdout, /keep-alive must be/);
  const model = spawnSync(PWSH, ['-NoProfile', '-File', SCRIPT, '-NoRestart', '-Model', 'x y'], { encoding: 'utf8' });
  assert.equal(model.status, 2, model.stdout);
});
