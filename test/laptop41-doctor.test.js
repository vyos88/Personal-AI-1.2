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

// files: paths under the temporary dir to write first, e.g. { 'app/.env.local': '...' }.
// curlExe: put a curl.exe on PATH, for checks that go through the doctor's Http/Body.
async function doctorAgainst(handler, { env: extraEnv = {}, files = {}, curlExe = false, stubs = '' } = {}) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), 'doctor-chat-'));
  mkdirSync(join(dir, 'app', 'software', 'backend'), { recursive: true });
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  const env = { ...process.env, OLLAMA_BASE_URL: '', OLLAMA_MODEL: '', ALPHA_PANEL_LAN_READ: '', ...extraEnv };
  if (curlExe) {
    // The doctor calls curl.exe by name and discards bodies to NUL.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'curl.exe'), '#!/bin/sh\nfor a; do shift; [ "$a" = NUL ] && a=/dev/null; set -- "$@" "$a"; done\nexec curl "$@"\n');
    chmodSync(join(bin, 'curl.exe'), 0o755);
    env.PATH = `${bin}${delimiter}${env.PATH}`;
  }
  const script = join(import.meta.dirname, '..', 'scripts', 'laptop41-doctor.ps1');
  const params = ['-AlphaRoot', join(dir, 'app', 'software'), '-OpsDir', join(dir, 'ops'),
    '-BackendPort', String(port), '-OllamaUrl', `http://127.0.0.1:${port}`, '-ChatModel', 'llama3.2:3b'];
  // stubs: PowerShell defined before the script runs, standing in for
  // Windows-only cmdlets such as Get-NetTCPConnection.
  const r = await runPwsh(stubs
    ? ['-NoProfile', '-Command', `${stubs}\n& '${script}' ${params.map((a) => (a.startsWith('-') ? a : `'${a}'`)).join(' ')}; exit $LASTEXITCODE`]
    : ['-NoProfile', '-File', script, ...params], env);
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

// 2026-10-06: Generate failed three ways at once and the doctor said nothing.
test('the Music Creator path is checked link by link', { skip, timeout: 300_000 }, async () => {
  const server = createServer((req, res) => {
    // The live site's mistake: /music went to Alpha's backend.
    if (req.url === '/music/healthz') return json(res, 404, { detail: 'Not Found' });
    json(res, 404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), 'doctor-music-'));
  mkdirSync(join(dir, 'app', 'software', 'backend'), { recursive: true });
  // The doctor calls curl.exe by name.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl.exe'), '#!/bin/sh\nexec curl "$@"\n');
  chmodSync(join(bin, 'curl.exe'), 0o755);
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, OLLAMA_BASE_URL: '', OLLAMA_MODEL: '' };
  const { out } = await runPwsh(['-NoProfile', '-File', join(import.meta.dirname, '..', 'scripts', 'laptop41-doctor.ps1'),
    '-AlphaRoot', join(dir, 'app', 'software'), '-OpsDir', join(dir, 'ops'), '-FrontendPort', String(port),
    '-BackendPort', String(port), '-OllamaUrl', `http://127.0.0.1:${port}`], env);
  server.close();
  assert.match(out, /=== 5b\. Music Creator ===/);
  assert.match(out, /PROBLEM: music bridge is not running on 127\.0\.0\.1:8790/);
  assert.match(out, /PROBLEM: the site sends \/music to Alpha's backend, not the music bridge/);
  assert.match(out, /"do":"enable-music","bridge":true/);
  assert.match(out, /=== 5c\. Image creator ===/);
  assert.match(out, /PROBLEM: image bridge is not running on 127\.0\.0\.1:7861/);
});

// Signed out of the coordinator, the doctor's agent list is the "Not signed
// in" text. Read as a fleet, it said "no machine offers alpha.music" on every
// run (Worker1, 2026-10-06), so the bridges are asked instead.
async function doctorWithBridges(routes) {
  const server = createServer((req, res) => {
    const hit = routes[req.url];
    if (hit) return json(res, hit[0], hit[1]);
    json(res, 404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = String(server.address().port);
  const dir = mkdtempSync(join(tmpdir(), 'doctor-fleet-'));
  mkdirSync(join(dir, 'app', 'software', 'backend'), { recursive: true });
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl.exe'), '#!/bin/sh\nexec curl "$@"\n');
  chmodSync(join(bin, 'curl.exe'), 0o755);
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, OLLAMA_BASE_URL: '', OLLAMA_MODEL: '' };
  const { out } = await runPwsh(['-NoProfile', '-File', join(import.meta.dirname, '..', 'scripts', 'laptop41-doctor.ps1'),
    '-AlphaRoot', join(dir, 'app', 'software'), '-OpsDir', join(dir, 'ops'), '-FrontendPort', port, '-BackendPort', port,
    '-MusicBridgePort', port, '-ImageBridgePort', port, '-OllamaUrl', `http://127.0.0.1:${port}`], env);
  server.close();
  return out;
}

test('signed out, the bridges say which machines make music and images', { skip, timeout: 300_000 }, async () => {
  const out = await doctorWithBridges({
    '/music/healthz': [200, { ok: true }],
    '/music/fleet': [200, { machines: [{ name: 'worker1', idleMs: 10, inFlight: 0 }, { name: 'host', idleMs: 5, inFlight: 1 }] }],
    '/healthz': [200, { ok: true }],
    '/sdapi/v1/sd-models': [200, [{ title: 'Alpha (host, worker1)', model_name: 'Alpha' }]],
  });
  assert.match(out, /ok: the site routes \/music to the bridge/);
  assert.match(out, /ok: machines that make music \(the music bridge's view\): worker1, host/);
  assert.match(out, /ok: machines that make images \(the image bridge's view\): host, worker1/);
  assert.doesNotMatch(out, /no machine offers alpha\.(music|image)/);
});

test('signed out, a bridge that cannot tell is not read as an empty fleet', { skip, timeout: 300_000 }, async () => {
  const out = await doctorWithBridges({
    '/music/healthz': [200, { ok: true }],
    '/music/fleet': [502, { error: 'bridge_key_rejected', message: 'issue it with agents:read' }],
    '/healthz': [200, { ok: true }],
    '/sdapi/v1/sd-models': [503, { error: 'no_image_machine', message: 'no attached machine offers alpha.image' }],
  });
  assert.match(out, /which machines make music is not known here: .*cannot list machines \(it needs agents:read\)/);
  assert.doesNotMatch(out, /no machine offers alpha\.music/);
  assert.match(out, /PROBLEM: no machine offers alpha\.image: the image bridge has nowhere to send work/);
});

// Alpha's deck panel polls /panel/crowpanel/public-state with no credential.
// The doctor says whether that feed is on, live, or stale and why.
const deckFeed = (code, body) => (req, res) => {
  if (req.url === '/panel/crowpanel/public-state') return json(res, code, body);
  json(res, 404, {});
};

test("Alpha's deck feed: live is ok", { skip, timeout: 300_000 }, async () => {
  const { out } = await doctorAgainst(deckFeed(200, { status: 'live', freshness: { stale: false, reason: 'live', heartbeat_age_s: 12 } }),
    { env: { ALPHA_PANEL_LAN_READ: 'true' }, curlExe: true });
  assert.match(out, /ok: Alpha's deck feed is live \(assistant heartbeat 12s old\)/);
  assert.doesNotMatch(out, /PROBLEM: Alpha's deck feed/);
});

test("Alpha's deck feed: stale says why and what clears it", { skip, timeout: 300_000 }, async () => {
  const { out } = await doctorAgainst(deckFeed(200, {
    status: 'degraded',
    freshness: { stale: true, reason: 'assistant-loop-not-started', advice: 'assistant loop is not running on the host.' },
  }), { env: { ALPHA_PANEL_LAN_READ: 'true' }, curlExe: true });
  assert.match(out, /PROBLEM: Alpha's deck feed is degraded: assistant-loop-not-started\. assistant loop is not running on the host\./);
  assert.match(out, /lightweight autonomy is off or interactive-first mode is on/);
});

// 2026-10-07: after a restart Worker1's loop stayed not-started, though the
// same task ran it before. The three settings that decide it are named with
// their value and where each came from, so a changed one shows.
test("Alpha's deck feed: a loop that is not started names the settings that start it", { skip, timeout: 300_000 }, async () => {
  const { out } = await doctorAgainst(deckFeed(200, {
    status: 'degraded',
    freshness: { stale: true, reason: 'assistant-loop-not-started', advice: 'assistant loop is not running on the host.' },
  }), { env: { ALPHA_PANEL_LAN_READ: 'true', ALPHA_INTERACTIVE_FIRST_MODE: 'true', ALPHA_LIGHTWEIGHT_AUTONOMY_ENABLED: 'true' }, curlExe: true });
  assert.match(out, /settings that start the loop: ALPHA_INTERACTIVE_FIRST_MODE=true \(environment \(Process\)\); ALPHA_LIGHTWEIGHT_AUTONOMY_ENABLED=true \(environment \(Process\)\); ALPHA_BACKGROUND_AUTOMATION_ENABLED not set/);
});

// 2026-10-07: Worker1's feed went heartbeat-stale with no restart in between.
// Whether the loop stalled or the panel snapshot is old decides the fix.
test("Alpha's deck feed: a stale heartbeat shows its age and the snapshot's", { skip, timeout: 300_000 }, async () => {
  const { out } = await doctorAgainst(deckFeed(200, {
    status: 'degraded', snapshot_age_s: 4.2,
    freshness: { stale: true, reason: 'heartbeat-stale', advice: 'feed stale', heartbeat_age_s: 900, threshold_s: 420, stale_since: '2026-10-07T01:26:00',
      cycle_step: 'serial-port-scan', cycle_step_since: '2026-10-07T01:28:00',
      lane_active_task: 'auto-improve', lane_waiting_task: 'assistant-monitor', lane_waiting_reason: 'host-resource-pressure' },
  }), { env: { ALPHA_PANEL_LAN_READ: 'true' }, curlExe: true });
  assert.match(out, /background lane held by 'auto-improve'; 'assistant-monitor' waits for it \(host-resource-pressure\)/);
  assert.match(out, /PROBLEM: Alpha's deck feed is degraded: heartbeat-stale/);
  assert.match(out, /assistant heartbeat 900s old \(live under 420s\); stale since 2026-10-07T01:26:00; panel snapshot 4\.2s old; assistant cycle in step 'serial-port-scan' since 2026-10-07T01:28:00/);
});

// The backend live on Laptop41 on 2026-10-06 predates Alpha#26: its feed has
// a status but no freshness block.
test("Alpha's deck feed: an older backend's stale feed points at Alpha#26", { skip, timeout: 300_000 }, async () => {
  const { out } = await doctorAgainst(deckFeed(200, { status: 'degraded', alive: false }), { env: { ALPHA_PANEL_LAN_READ: 'true' }, curlExe: true });
  assert.match(out, /PROBLEM: Alpha's deck feed is degraded, and this backend does not say why: it predates Alpha#26/);
  assert.match(out, /Alpha#26 \(merged to alpha-full\) keeps it fresh between cycles/);
});

test("Alpha's deck feed: off in .env.local is named, with the setting and file", { skip, timeout: 300_000 }, async () => {
  const { out } = await doctorAgainst(deckFeed(404, { detail: 'Not Found' }),
    { files: { 'app/.env.local': 'HOST=127.0.0.1\nALPHA_PANEL_LAN_READ=false\nALPHA_PANEL_LAN_READ=true\n' }, curlExe: true });
  assert.match(out, /PROBLEM: Alpha's deck feed is off: ALPHA_PANEL_LAN_READ is 'false' in \S+\.env\.local, so the deck panel has nothing to read/);
  assert.match(out, /Turn on the deck feed: set ALPHA_PANEL_LAN_READ=true/);
});

test("Alpha's deck feed: on but 404 means the backend predates the setting", { skip, timeout: 300_000 }, async () => {
  const { out } = await doctorAgainst(deckFeed(404, { detail: 'Not Found' }), { env: { ALPHA_PANEL_LAN_READ: 'true' }, curlExe: true });
  assert.match(out, /PROBLEM: Alpha's deck feed answers 404 though ALPHA_PANEL_LAN_READ=true \(environment \(Process\)\): the backend started before that was set/);
  assert.match(out, /Restart the backend so it reads its settings again/);
});

// Laptop41's addresses as Windows reports them: Ethernet on the home network,
// the WSL switch, and the tailnet. Connections are filtered by state only.
const netStubs = (listen, connections, own = [['192.168.1.250', 'Ethernet']]) => `
function Get-NetIPAddress {
${own.map(([ip, nic]) => `  [pscustomobject]@{ IPAddress = '${ip}'; InterfaceAlias = '${nic}' }`).join('\n')}
  [pscustomobject]@{ IPAddress = '172.20.0.1'; InterfaceAlias = 'vEthernet (WSL)' }
  [pscustomobject]@{ IPAddress = '100.69.243.25'; InterfaceAlias = 'Tailscale' }
}
function Get-NetTCPConnection {
  param($LocalPort, $State)
  $rows = @(
${listen.map((a) => `    [pscustomobject]@{ LocalAddress = '${a}'; State = 'Listen'; RemoteAddress = '0.0.0.0' }`).join('\n')}
${connections.map(([remote, state]) => `    [pscustomobject]@{ LocalAddress = '192.168.1.250'; State = '${state}'; RemoteAddress = '${remote}' }`).join('\n')}
  )
  if ($State) { $rows | Where-Object { $_.State -eq $State } } else { $rows }
}`;

// HOST in .env.local named 127.0.0.1 and the tailnet address only: the
// backend answered at home and on the tailnet, and the panel on WiFi had no
// way in.
test("Alpha's deck feed: a backend bound to no home-network address is the problem named", { skip, timeout: 300_000 }, async () => {
  const { out } = await doctorAgainst(deckFeed(200, { status: 'live', freshness: { reason: 'live', heartbeat_age_s: 3 } }), {
    env: { ALPHA_PANEL_LAN_READ: 'true' }, curlExe: true,
    stubs: netStubs(['127.0.0.1', '100.69.243.25'], [['127.0.0.1', 'Established']]),
  });
  assert.match(out, /backend listens on: 100\.69\.243\.25, 127\.0\.0\.1/);
  assert.match(out, /not listening on 192\.168\.1\.250 \(Ethernet\)/);
  assert.doesNotMatch(out, /172\.20\.0\.1/);
  assert.match(out, /PROBLEM: the backend listens on no home-network address \(this machine has 192\.168\.1\.250 on Ethernet\): the deck panel cannot reach it/);
  assert.match(out, /PROBLEM: no device on the home network has called the backend in the last couple of minutes/);
  assert.match(out, /Add the home-network address section 6 names to HOST in \.env\.local/);
});

// The WSL switch's address is in the home-network range but is this machine.
test("Alpha's deck feed: the panel's calls are counted, this machine's own are not", { skip, timeout: 300_000 }, async () => {
  const { out } = await doctorAgainst(deckFeed(200, { status: 'live', freshness: { reason: 'live', heartbeat_age_s: 3 } }), {
    env: { ALPHA_PANEL_LAN_READ: 'true' }, curlExe: true,
    stubs: netStubs(['127.0.0.1'], [['::ffff:192.168.1.97', 'Established'], ['192.168.1.97', 'TimeWait'], ['172.20.0.1', 'TimeWait'], ['100.69.243.25', 'Established']], []),
  });
  assert.match(out, /ok: home-network devices that called the backend in the last couple of minutes: 192\.168\.1\.97 \(2 connections\)/);
  assert.doesNotMatch(out, /PROBLEM: (the backend listens on no|no device on the home network)/);
});

// ---------------------------------------------------------------- CPU pressure
//
// The one number section 7 did not print, on the machine it mattered most on.
//
// Alpha gates every local model call on system CPU. At or above the hold,
// gpu_work.py's admission_reason refuses and the caller gets a 502: "Timeout:
// Waiting for system CPU below the configured hold limit; GPU admission timed
// out without starting language-model". Worse, the only place that schedules a
// GPU telemetry probe is itself guarded on being under that hold, so while CPU
// is pinned the telemetry never becomes "observed" and admission then refuses
// with "Waiting for fresh per-adapter GPU telemetry" even once CPU drops. On
// Worker1 that produced 201 agent receipts, every one classed
// evidence-contract, from models that never started.
//
// Section 7 ranked working set and read no CPU at all, so the number that
// explained a stalled fleet was the one nothing printed.
//
// `Read-CpuPressure` is the seam, exposed as `-ReadCpuPressure` the way
// repair-alpha-host.ps1 exposes `-ReadAgentList`, and answered before the
// script creates a directory or writes a report.
const DOCTOR = join(import.meta.dirname, '..', 'scripts', 'laptop41-doctor.ps1');
const readCpu = (percent) => {
  const r = spawnSync(PWSH, ['-NoProfile', '-File', DOCTOR, '-ReadCpuPressure', percent], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // The seam must answer before the script touches the machine. On a host with
  // no C: drive the rest of the doctor cannot run, so a clean stderr is also
  // the proof that nothing below the seam executed.
  assert.doesNotMatch(r.stderr, /Cannot find drive/, 'the seam ran after the report directory was created');
  return JSON.parse(r.stdout);
};

test('a CPU at or above the hold is a problem that names the consequence', { skip }, () => {
  for (const value of ['95', '90', '99.9']) {
    const verdict = readCpu(value);
    assert.equal(verdict.measured, true, value);
    assert.equal(verdict.holding, true, value);
    // The note carries the consequence, or a reader sees a percentage and not
    // the reason every agent receipt says evidence-contract.
    assert.match(verdict.note, /GPU-admission hold/, value);
    assert.match(verdict.note, /evidence-contract/, value);
  }
});

test('the CPU hold is inclusive, because Alpha compares with >=', { skip }, () => {
  // gpu_work.py: `if float(cpu_percent) >= float(cpu_hold_percent)`. Exactly 90
  // is held, so calling it fine would disagree with the gate this mirrors.
  assert.equal(readCpu('90').holding, true);
  assert.equal(readCpu('89.9').holding, false);
});

test('a CPU below the hold still says what the hold is', { skip }, () => {
  const verdict = readCpu('12.4');
  assert.equal(verdict.measured, true);
  assert.equal(verdict.holding, false);
  assert.equal(verdict.percent, 12.4);
  // Without the threshold, 12.4% is a number with nothing to compare against.
  assert.match(verdict.note, /holds GPU admission at 90%/);
});

test('an unmeasurable CPU is never read as idle', { skip }, () => {
  // Win32_Processor.LoadPercentage is absent on some hosts. Calling that 0%
  // would say "the CPU is free" about the machine least able to prove it --
  // the rule the coordinator already applies to a missing agent load report.
  for (const value of ['', '   ']) {
    const verdict = readCpu(value);
    assert.equal(verdict.measured, false, JSON.stringify(value));
    assert.equal(verdict.percent, null, JSON.stringify(value));
    assert.equal(verdict.holding, null, JSON.stringify(value));
    assert.match(verdict.note, /unknown is not idle/, JSON.stringify(value));
  }
});

test('a CPU reading that is not a number is unreadable, and says what it got', { skip }, () => {
  const verdict = readCpu('n/a');
  assert.equal(verdict.measured, false);
  assert.equal(verdict.holding, null);
  // The text comes back so a wrong counter can be told from a missing one.
  assert.match(verdict.note, /unreadable: n\/a/);
});
