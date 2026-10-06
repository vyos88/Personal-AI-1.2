import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// scripts/laptop41-doctor.ps1 needs PowerShell. Set PWSH to its path, or have
// pwsh on PATH; without it these tests are skipped, not failed.
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const skip = hasPwsh ? false : 'PowerShell not found (set PWSH)';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

test('the scheduled doctor finds scripts\\ beside software\\ and relays both cloud branches', { skip, timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-relay-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(work, 'scripts'));
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'laptop41-doctor.ps1'), join(work, 'scripts', 'laptop41-doctor.ps1'));
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '--orphan', 'status/cloud');
  git(work, 'rm', '-rq', '--cached', '.');
  mkdirSync(join(work, 'reports'));
  writeFileSync(join(work, 'reports', 'cloud.md'), 'Claude (cloud) report, test\n');
  git(work, 'add', 'reports/cloud.md');
  git(work, 'commit', '-qm', 'cloud');
  git(work, 'push', '-q', 'origin', 'status/cloud');
  const cloudHead = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'checkout', '-q', '--orphan', 'status/claude-laptop41');
  git(work, 'rm', '-rq', '--cached', '.');
  writeFileSync(join(work, 'reports', 'handoff.md'), '# Claude handoff, test\n');
  git(work, 'add', 'reports/handoff.md');
  git(work, 'commit', '-qm', 'handoff');
  git(work, 'push', '-q', 'origin', 'status/claude-laptop41');
  const handoffHead = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'checkout', '-q', '-f', 'main');
  git(work, 'clean', '-qfd');

  // Laptop41's layout: the schedule passes software\ as -AlphaRoot, and
  // Alpha's coordination script sits in scripts\ beside it. A stand-in
  // records what would have been posted.
  const app = join(dir, 'app');
  mkdirSync(join(app, 'software', 'backend'), { recursive: true });
  mkdirSync(join(app, 'scripts'));
  const posts = join(app, 'scripts', 'posts.log');
  writeFileSync(join(app, 'scripts', 'alpha_coordination_tunnel.ps1'),
    'param([string]$Action, [string]$Actor, [string]$Message)\n' +
    'Add-Content -Path (Join-Path $PSScriptRoot "posts.log") -Value "$Action|$Actor|$($Message.Split("`n")[0])"\n' +
    'exit 0\n');
  // The doctor calls powershell.exe by name.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'powershell.exe'), `#!/bin/sh\nexec "${PWSH}" "$@"\n`);
  chmodSync(join(bin, 'powershell.exe'), 0o755);
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const ops = join(dir, 'ops');
  // Laptop41 runs Windows PowerShell 5.1, which passes native arguments the
  // legacy way: a " inside -Message is not escaped and splits the message.
  // Legacy mode reproduces that here.
  const args = ['-NoProfile', '-Command',
    `$PSNativeCommandArgumentPassing = 'Legacy'; & '${join(work, 'scripts', 'laptop41-doctor.ps1')}' -Watch -AlphaRoot '${join(app, 'software')}' -OpsDir '${ops}'; exit $LASTEXITCODE`];

  const first = spawnSync(PWSH, args, { encoding: 'utf8', env });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.ok(existsSync(posts), `nothing was posted:\n${first.stdout}`);
  const lines = readFileSync(posts, 'utf8').trim().split(/\r?\n/);
  assert.ok(lines.some((l) => /^Post\|alpha-doctor\|Alpha host check/.test(l)), lines.join('\n'));
  assert.ok(lines.includes('Post|claude-cloud|Claude (cloud) report, test'), lines.join('\n'));
  const state = JSON.parse(readFileSync(join(ops, 'doctor-state.json'), 'utf8'));
  assert.ok(lines.includes('Post|claude-laptop41|# Claude handoff, test'), lines.join('\n'));
  assert.equal(state.cloudSeen, cloudHead);
  assert.equal(state.handoffSeen, handoffHead);
  assert.ok(state.lastPost, 'lastPost is recorded');
  assert.match(state.relay, /relayed status\//);

  const pushes = () => Number(git(remote, 'rev-list', '--count', 'status/laptop41').trim());
  const pushedFirst = pushes();
  assert.ok(pushedFirst >= 1, 'the first run pushed status/laptop41');

  // A new handoff arrives while nothing else changed: the relay alone is
  // reason to push, or the cloud session never sees that it got through.
  git(work, 'checkout', '-q', 'status/claude-laptop41');
  writeFileSync(join(work, 'reports', 'handoff.md'), '# Claude handoff, second: "Claude · Worker1" works\nline two\n');
  git(work, 'commit', '-qam', 'handoff 2');
  git(work, 'push', '-q', 'origin', 'status/claude-laptop41');
  const handoff2 = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'checkout', '-q', 'main');

  // The same reports are relayed once, not every 15 minutes.
  const second = spawnSync(PWSH, args, { encoding: 'utf8', env });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const again = readFileSync(posts, 'utf8').trim().split(/\r?\n/);
  assert.equal(again.filter((l) => l.startsWith('Post|claude-cloud|')).length, 1);
  assert.equal(again.filter((l) => l.startsWith('Post|claude-laptop41|')).length, 2);
  assert.ok(again.includes('Post|claude-laptop41|# Claude handoff, second: "Claude · Worker1" works'), again.join('\n'));
  assert.equal(pushes(), pushedFirst + 1, 'the new relay was pushed');
  const pushedState = JSON.parse(git(remote, 'show', 'status/laptop41:reports/doctor-state.json'));
  assert.equal(pushedState.handoffSeen, handoff2);

  // Nothing new: nothing relayed again.
  const third = spawnSync(PWSH, args, { encoding: 'utf8', env });
  assert.equal(third.status, 0, third.stdout + third.stderr);
  assert.equal(readFileSync(posts, 'utf8').trim().split(/\r?\n/).filter((l) => l.startsWith('Post|claude-')).length, 3);
});

// Chat is checked without a login: /ready, /chat guarded, Ollama has the
// model and answers. A stand-in serves both the backend and Ollama.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

function runPwsh(args, env) {
  return new Promise((resolve) => {
    const p = spawn(PWSH, args, { env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (status) => resolve({ status, out }));
  });
}

async function doctorAgainst(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), 'doctor-chat-'));
  mkdirSync(join(dir, 'app', 'software', 'backend'), { recursive: true });
  const env = { ...process.env, OLLAMA_BASE_URL: '', OLLAMA_MODEL: '' };
  const r = await runPwsh(['-NoProfile', '-File', join(import.meta.dirname, '..', 'scripts', 'laptop41-doctor.ps1'),
    '-AlphaRoot', join(dir, 'app', 'software'), '-OpsDir', join(dir, 'ops'),
    '-BackendPort', String(port), '-OllamaUrl', `http://127.0.0.1:${port}`, '-ChatModel', 'llama3.2:3b'], env);
  server.close();
  return r;
}

// Ollama's own format: nanoseconds and a local offset, e.g. 2026-10-07T17:40:00.123456789+01:00.
const ollamaTime = (ms) => new Date(ms + 3600e3).toISOString().replace('Z', '').replace(/\.(\d{3})$/, '.$1456789') + '+01:00';
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

test('chat is checked without a login: route guarded, model pulled and answering', { skip, timeout: 300_000 }, async () => {
  const { status, out } = await doctorAgainst((req, res) => {
    if (req.url === '/ready') return json(res, 200, { ready: true, phase: 'ready' });
    if (req.url === '/chat') return json(res, 401, { detail: 'Not authenticated' });
    if (req.url === '/api/tags') return json(res, 200, { models: [{ name: 'llama3.2:3b' }] });
    if (req.url === '/api/generate') return json(res, 200, { response: 'OK', load_duration: 2e9, eval_count: 4, eval_duration: 1e9 });
    if (req.url === '/api/ps') return json(res, 200, { models: [{ name: 'llama3.2:3b', expires_at: ollamaTime(Date.now() + 24 * 3600e3) }] });
    json(res, 404, {});
  });
  assert.equal(status, 0, out);
  assert.match(out, /ok: Ollama keeps 'llama3\.2:3b' loaded for 24 h after each use/);
  assert.match(out, /ok: backend ready \(phase ready\)/);
  assert.match(out, /ok: \/chat is mounted and asks for a login \(HTTP 401\)/);
  assert.match(out, /ok: chat model 'llama3\.2:3b' answered in [\d.]+s \(load 2s, 4 tokens\/s\): OK/);
  assert.doesNotMatch(out, /PROBLEM: (backend (is still|\/ready)|\/chat|Ollama|chat model)/);
});

test('a missing chat model and an open /chat are problems with a next step', { skip, timeout: 300_000 }, async () => {
  const { out } = await doctorAgainst((req, res) => {
    if (req.url === '/ready') return json(res, 503, { ready: false });
    if (req.url === '/chat') return json(res, 200, { response: 'hi' });
    if (req.url === '/api/tags') return json(res, 200, { models: [{ name: 'qwen2.5:0.5b' }] });
    json(res, 404, {});
  });
  assert.match(out, /PROBLEM: backend is still warming up/);
  assert.match(out, /PROBLEM: \/chat answered without a login/);
  assert.match(out, /Ollama models: qwen2\.5:0\.5b/);
  assert.match(out, /PROBLEM: chat model 'llama3\.2:3b' is not pulled in Ollama/);
  assert.match(out, /Pull the chat model/);
});

// 2026-10-06: a 77.9s reply was 75.6s of loading at a normal speed. That is a
// keep-alive problem, and "close apps or move chat" was the wrong advice.
test('a slow load is reported as a load, with the keep-alive fix', { skip, timeout: 300_000 }, async () => {
  const { out } = await doctorAgainst((req, res) => {
    if (req.url === '/ready') return json(res, 200, { ready: true, phase: 'ready' });
    if (req.url === '/chat') return json(res, 401, {});
    if (req.url === '/api/tags') return json(res, 200, { models: [{ name: 'llama3.2:3b' }] });
    if (req.url === '/api/generate') return json(res, 200, { response: 'OK', load_duration: 75.6e9, eval_count: 9, eval_duration: 1e9 });
    if (req.url === '/api/ps') return json(res, 200, { models: [{ name: 'llama3.2:3b', expires_at: ollamaTime(Date.now() + 5 * 60e3) }] });
    json(res, 404, {});
  });
  assert.match(out, /PROBLEM: chat model 'llama3\.2:3b' took 75\.6s to load: the first chat after an idle spell waits that long/);
  assert.doesNotMatch(out, /to answer once loaded/);
  assert.match(out, /Ollama unloads 'llama3\.2:3b' 5 min after each use/);
  assert.match(out, /"do":"ollama-keepalive"/);
  assert.doesNotMatch(out, /close heavy apps/);
});
