// The two read-only failed-login checks (HANDOFF_2026-10-05f): the
// coordinator's log on Host, and Alpha's sign-in records on Worker1. Both are
// run as a person runs them, through PowerShell, against sample data in the
// real formats: the coordinator's log line from src/common/log.js and Alpha's
// auth_security_events and audit_events tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const PY = (() => {
  for (const name of ['python3', 'python']) {
    try { execFileSync(name, ['--version']); return name; } catch { /* next */ }
  }
  return null;
})();
const HAS_PWSH = (() => { try { execFileSync('pwsh', ['-NoProfile', '-Command', '1']); return true; } catch { return false; } })();
const skip = (!PY || !HAS_PWSH) && 'needs python and pwsh';

const pwsh = (script, ...args) =>
  execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(SCRIPTS, script), ...args], { encoding: 'utf8' });

test('the coordinator check counts failed logins by reason, address and source', { skip: !HAS_PWSH && 'needs pwsh' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-log-'));
  const log = join(dir, 'alpha-tunnel-coordinator.log');
  writeFileSync(log, [
    '21:10:01.001 INFO  [host:auth] login succeeded userId=u1 email=owner@example.test remoteAddress=100.69.243.25 forwardedFor=null',
    '21:10:05.123 WARN  [host:auth] login failed reason=wrong_password email=owner@example.test failures=1 remoteAddress=100.69.243.25 forwardedFor=null',
    '21:10:09.456 WARN  [host:auth] login failed reason=wrong_password email=owner@example.test failures=2 remoteAddress=100.69.243.25 forwardedFor=null',
    '21:11:00.000 WARN  [host:auth] login failed reason=malformed_email email="VyoS" remoteAddress=127.0.0.1 forwardedFor=null',
    '21:12:00.000 WARN  [host:auth] login failed reason=locked_out email=owner@example.test failures=8 remoteAddress=100.69.243.25 forwardedFor=null',
    '',
  ].join('\n'));

  const out = pwsh('check-coordinator-logins.ps1', '-Log', log);
  assert.match(out, /^4 failed logins in /m, 'a successful login is not counted');
  assert.match(out, /^\s+2 {2}wrong_password {2}owner@example\.test {2}from 100\.69\.243\.25$/m);
  assert.match(out, /^\s+1 {2}malformed_email {2}"VyoS" {2}from 127\.0\.0\.1$/m);
  assert.match(out, /^\s+1 {2}locked_out {2}owner@example\.test {2}from 100\.69\.243\.25$/m);
  assert.match(out, /^first: 21:10:05\.123 /m);
  assert.match(out, /^last: {2}21:12:00\.000 /m);
});

test('the Alpha check groups recent failed sign-ins, names the stewards and never prints .env.local', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'alpha-root-'));
  mkdirSync(join(root, 'memory', 'local'), { recursive: true });
  mkdirSync(join(root, 'data'));
  // The auth db sits where .env.local says; the audit db at its default.
  writeFileSync(join(root, '.env.local'), 'AUTH_PASSWORD=do-not-print-this\nAUTH_USERS_DB_PATH=data/auth_users.db\n');
  writeFileSync(join(root, 'memory', 'local', 'alpha-local-service.credential.xml'), '<Objs/>');
  execFileSync(PY, ['-c', `
import sqlite3, datetime as d, sys
now = d.datetime.utcnow()
a = sqlite3.connect(sys.argv[1])
a.execute('create table auth_security_events (event_id text, event_type text, username text, ip_address text, user_agent text, detail_json text, created_at text, acknowledged_at text)')
for i in range(40):
    a.execute('insert into auth_security_events values (?,?,?,?,?,?,?,?)', (str(i), 'login-failed', 'VyoS', '127.0.0.1', 'Mozilla/5.0 (Windows NT; Windows NT 10.0; en-US) WindowsPowerShell/5.1', '{}', (now - d.timedelta(minutes=i)).isoformat(), None))
a.execute('insert into auth_security_events values (?,?,?,?,?,?,?,?)', ('old', 'login-failed', 'admin', '203.0.113.9', 'curl/8.0', '{}', (now - d.timedelta(days=3)).isoformat(), None))
a.execute('insert into auth_security_events values (?,?,?,?,?,?,?,?)', ('ok', 'password-changed', 'VyoS', '127.0.0.1', 'x', '{}', now.isoformat(), None))
a.commit()
b = sqlite3.connect(sys.argv[2])
b.execute('create table audit_events (id integer primary key, event_id text, timestamp text, actor text, ip text, route text, method text, action text, resource_type text, resource_id text, status text, detail text)')
b.execute("insert into audit_events (event_id, timestamp, actor, ip, action, status, detail) values ('e1', ?, 'VyoS', '127.0.0.1', 'login', 'blocked', '{\\"reason\\": \\"account_rate_limit\\"}')", (now.isoformat(),))
b.execute("insert into audit_events (event_id, timestamp, actor, ip, action, status, detail) values ('e2', ?, 'VyoS', '127.0.0.1', 'login', 'success', '{}')", (now.isoformat(),))
# Worker1's live backend wrote failures here only (2026-10-06): 25 in the last
# 50 minutes, 7 of them in the last 15, plus one too old to count.
for i in range(25):
    b.execute("insert into audit_events (event_id, timestamp, actor, ip, action, status, detail) values (?, ?, 'VyoS', '127.0.0.1', 'login', 'failure', '{}')", ('f%d' % i, (now - d.timedelta(minutes=2 + 2 * i, seconds=30)).isoformat()))
b.execute("insert into audit_events (event_id, timestamp, actor, ip, action, status, detail) values ('fold', ?, 'root', '198.51.100.7', 'login', 'failure', '{}')", ((now - d.timedelta(days=2)).isoformat(),))
b.commit()
`, join(root, 'data', 'auth_users.db'), join(root, 'memory', 'audit_store.db')]);

  // The stewards as Worker1 runs them: start_visible_alpha_codex_agents.ps1
  // opens each window with -EncodedCommand, so its script name is hidden.
  const encoded = (text) => Buffer.from(text, 'utf16le').toString('base64');
  const windowCommand = (title, script) => `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoExit -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded(
    `$Host.UI.RawUI.WindowTitle='${title}'; Set-Location -LiteralPath 'C:\\Alpha'; & 'C:\\Alpha\\scripts\\${script}'`)}`;
  const processes = join(root, 'processes.json');
  writeFileSync(processes, JSON.stringify([
    { ProcessId: 2984, CommandLine: windowCommand('ALPHA AGENT MANAGER', 'alpha_agent_manager.ps1') },
    { ProcessId: 15808, CommandLine: windowCommand('ALPHA GOVERNED WORKSPACE AGENT', 'watch_alpha_workspace_agent.ps1') },
    { ProcessId: 4100, CommandLine: 'powershell.exe -NoProfile -File C:\\Alpha\\scripts\\alpha_gmail_triage_steward.ps1' },
    // Not stewards: the tray, another encoded window, and an undecodable one.
    { ProcessId: 1196, CommandLine: 'powershell.exe -NoLogo -STA -File C:\\Alpha\\scripts\\alpha-desktop-tray.ps1 -OpenLiveTerminals' },
    { ProcessId: 7000, CommandLine: windowCommand('BUILD WINDOW', 'build-alpha-update.ps1') },
    { ProcessId: 7001, CommandLine: 'powershell.exe -EncodedCommand !!!!not-base64-at-all!!!!' },
  ]));

  const out = pwsh('check-alpha-logins.ps1', '-AlphaRoot', join(root, 'software'), '-Python', PY, '-ProcessList', processes);
  assert.ok(!out.includes('do-not-print-this'), 'the .env.local file is never printed');
  assert.match(out, /^Alpha root: /m, 'a path ending in software is taken as its parent');
  assert.ok(out.includes(join(root, 'data', 'auth_users.db')), 'the auth db path comes from .env.local');
  assert.match(out, /^\s+40 {2}127\.0\.0\.1\s+VyoS\s+Mozilla\/5\.0 \(Windows NT; Windows NT 10\.0; en-US\) WindowsPowerShell\/5\.1/m);
  assert.ok(!out.includes('203.0.113.9'), 'a failure older than 24 hours is left out');
  assert.match(out, /^\s+1 {2}127\.0\.0\.1\s+VyoS\s+\{"reason": "account_rate_limit"\}/m);
  assert.match(out, /alpha-local-service\.credential\.xml {2}last changed /);
  assert.match(out, /steward-auth-backoff\.json {2}\(none\)/);

  // Failures recorded only in audit_events are counted, and whether they are still happening.
  const audit = out.slice(out.indexOf('(audit_events):'), out.indexOf('Blocked sign-ins'));
  assert.match(audit, /^\s+25 {2}127\.0\.0\.1\s+VyoS\s+\[/m);
  assert.match(audit, /^ {2}in the last 15 minutes: 7$/m);
  assert.ok(!audit.includes('198.51.100.7'), 'an audit failure older than 24 hours is left out');

  // Stewards are found by decoded window title as well as by script name.
  const stewards = out.slice(out.indexOf('Steward processes running:'));
  assert.match(stewards, /^\s+2984 {2}ALPHA AGENT MANAGER {2}scripts\\alpha_agent_manager\.ps1 {2}\(-EncodedCommand\)$/m);
  assert.match(stewards, /^\s+15808 {2}ALPHA GOVERNED WORKSPACE AGENT {2}scripts\\watch_alpha_workspace_agent\.ps1 {2}\(-EncodedCommand\)$/m);
  assert.match(stewards, /^\s+4100 {2}scripts\\alpha_gmail_triage_steward\.ps1$/m);
  for (const pid of ['1196', '7000', '7001']) assert.ok(!new RegExp(`^\\s+${pid} `, 'm').test(stewards), `pid ${pid} is not a steward`);
  assert.ok(!stewards.includes('could not list processes'));
});
