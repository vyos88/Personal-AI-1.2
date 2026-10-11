import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/alpha-standdown.ps1 needs PowerShell. Set PWSH to its path, or have
// pwsh on PATH; without it these tests are skipped, not failed.
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const skip = hasPwsh ? false : 'PowerShell not found (set PWSH)';
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'alpha-standdown.ps1');

// Stand-ins for the Windows cmdlets, over one JSON file: scheduled tasks, the
// cloudflared service, processes, listeners and the two URLs. Every change is
// logged in order, so the test can say what happened first.
const FAKES = String.raw`
function Load { Get-Content -LiteralPath $env:FAKE_STATE -Raw | ConvertFrom-Json }
function Save($s) { $s | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $env:FAKE_STATE }
function Log($t) { $s = Load; $s.log = @($s.log) + $t; Save $s }
function Get-ScheduledTask { param([string]$TaskName)
  $all = @((Load).tasks | ForEach-Object { [pscustomobject]@{ TaskName = $_.name; State = $_.state; Actions = @([pscustomobject]@{ Execute = $_.exec; Arguments = '' }) } })
  if ($TaskName) { $all | Where-Object { $_.TaskName -eq $TaskName } } else { $all } }
function Set-TaskState($n, $st) { $s = Load; foreach ($t in $s.tasks) { if ($t.name -eq $n) { $t.state = $st } }; Save $s }
function Disable-ScheduledTask { param([string]$TaskName) Set-TaskState $TaskName 'Disabled'; Log "disable $TaskName" }
function Enable-ScheduledTask { param([string]$TaskName) Set-TaskState $TaskName 'Ready'; Log "enable $TaskName" }
function Stop-ScheduledTask { param([string]$TaskName) Log "stop-task $TaskName" }
function Start-ScheduledTask { param([string]$TaskName) Log "start-task $TaskName" }
function Get-Service { param([string]$Name) $s = Load; if ($s.service) { [pscustomobject]@{ Status = $s.service.status; StartType = $s.service.startType } } }
function Stop-Service { param([string]$Name) $s = Load; $s.service.status = 'Stopped'; $s.procs = @($s.procs | Where-Object { $_.ParentProcessId -ne 500 }); Save $s; Log 'stop-service' }
function Start-Service { param([string]$Name) $s = Load; $s.service.status = 'Running'
  if (-not $s.serviceFails) { $s.procs = @($s.procs) + [pscustomobject]@{ ProcessId = 601; ParentProcessId = 500; Name = 'cloudflared.exe'; CommandLine = 'x' } }
  Save $s; Log 'start-service' }
function Set-Service { param([string]$Name, [string]$StartupType) $s = Load; $s.service.startType = $StartupType; Save $s; Log "service-start $StartupType" }
function Get-CimInstance { param($ClassName, $Filter)
  if ($ClassName -eq 'Win32_Service') { $s = Load; if ($s.service) { return [pscustomobject]@{ ExitCode = $s.service.exitCode; PathName = 'C:\cf\cloudflared.exe tunnel run --token SECRET-SERVICE-TOKEN' } } else { return } }
  @((Load).procs | ForEach-Object { [pscustomobject]@{ ProcessId = [int]$_.ProcessId; ParentProcessId = [int]$_.ParentProcessId; Name = $_.Name; CommandLine = $_.CommandLine } }) }
function Get-NetTCPConnection { param($LocalPort, $State) @((Load).listen | Where-Object { $_.port -eq $LocalPort } | ForEach-Object { [pscustomobject]@{ OwningProcess = [int]$_.pid; LocalAddress = '127.0.0.1' } }) }
function taskkill.exe { $id = [int]$args[-1]; $s = Load
  $gone = @($id); do { $more = @($s.procs | Where-Object { $gone -contains $_.ParentProcessId -and $gone -notcontains $_.ProcessId } | ForEach-Object { [int]$_.ProcessId }); $gone += $more } while ($more.Count)
  $s.procs = @($s.procs | Where-Object { $gone -notcontains $_.ProcessId }); $s.listen = @($s.listen | Where-Object { $gone -notcontains $_.pid }); Save $s; Log "kill $id" }
function Invoke-WebRequest { param($Uri) $s = Load
  if ($Uri -like '*127.0.0.1*') { if ($s.backendUp) { return [pscustomobject]@{ StatusCode = 200 } } else { throw 'refused' } }
  if ($s.public) { return [pscustomobject]@{ StatusCode = $s.public } } else { throw 'down' } }
function Start-Sleep { }
`;

// Worker1 serving Alpha: both watchers on, backend and site under their boot
// wrappers, the connector as a service plus a task that runs it at logon.
function serving(extra = {}) {
  return {
    tasks: [
      { name: 'Alpha Self-Heal', state: 'Ready', exec: 'node.exe' },
      { name: 'Alpha Server - Health Guard', state: 'Ready', exec: 'powershell.exe' },
      { name: 'Alpha Backend', state: 'Running', exec: 'cmd.exe' },
      { name: 'Alpha', state: 'Running', exec: 'cmd.exe' },
      { name: 'Cloudflared at logon', state: 'Ready', exec: 'C:\\cloudflared\\cloudflared.exe' },
      { name: 'Alpha Doctor', state: 'Ready', exec: 'powershell.exe' },
    ],
    service: { status: 'Running', startType: 'Automatic', exitCode: 0 },
    procs: [
      { ProcessId: 500, ParentProcessId: 4, Name: 'services.exe', CommandLine: '' },
      { ProcessId: 600, ParentProcessId: 500, Name: 'cloudflared.exe', CommandLine: 'cloudflared.exe tunnel run --token SECRET-TOKEN-123' },
      { ProcessId: 700, ParentProcessId: 1, Name: 'cmd.exe', CommandLine: 'cmd.exe /c "C:\\ProgramData\\AlphaBoot\\run-alpha-backend.cmd"' },
      { ProcessId: 701, ParentProcessId: 700, Name: 'python.exe', CommandLine: 'python run_server.py --host 127.0.0.1' },
      { ProcessId: 710, ParentProcessId: 1, Name: 'cmd.exe', CommandLine: 'cmd.exe /c "C:\\ProgramData\\AlphaBoot\\run-alpha.cmd"' },
      { ProcessId: 711, ParentProcessId: 710, Name: 'node.exe', CommandLine: 'node vite preview' },
    ],
    listen: [{ port: 8001, pid: 701 }, { port: 4173, pid: 711 }],
    public: 0,
    backendUp: false,
    log: [],
    ...extra,
  };
}

function setup(state) {
  const dir = mkdtempSync(join(tmpdir(), 'standdown-'));
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify(state));
  const ops = join(dir, 'ops');
  const run = (...args) => {
    const r = spawnSync(PWSH, ['-NoProfile', '-Command', `${FAKES}; & '${SCRIPT}' -OpsDir '${ops}' ${args.join(' ')}; exit $LASTEXITCODE`],
      { encoding: 'utf8', env: { ...process.env, FAKE_STATE: file, COMPUTERNAME: 'DESKTOP-41HPLCN' } });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  const set = (patch) => writeFileSync(file, JSON.stringify({ ...read(), ...patch }));
  return { dir, ops, run, read, set };
}

const taskState = (s, name) => s.tasks.find((t) => t.name === name).state;

test('the rehearsal says what it would stop and changes nothing', { skip }, () => {
  const { ops, run, read } = setup(serving());
  const r = run('-ReportOnly');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /report only: nothing is changed/);
  assert.match(r.out, /disable 'Alpha Self-Heal'/);
  assert.match(r.out, /disable 'Cloudflared at logon'/);
  assert.match(r.out, /stop python 701 and its children/);
  assert.match(r.out, /stop cloudflared 600/);
  assert.match(r.out, /cloudflared 600 \(parent services\)/, 'who started the connector is named');
  assert.deepEqual(read().log, []);
  assert.equal(existsSync(join(ops, 'role.json')), false);
  assert.doesNotMatch(r.out, /SECRET-TOKEN/, 'a command line is never printed');
  assert.match(r.out, /service  cloudflared Running, start Automatic, last exit code 0, --token on its command line yes/);
  assert.doesNotMatch(r.out, /SECRET-SERVICE-TOKEN/, 'only whether there is a token, never the token');
});

test('standing down disables the watchers first, stops Alpha and its connector, and records it all', { skip }, () => {
  const { ops, run, read } = setup(serving());
  const r = run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /RESULT: stood down\. laptop-gj8dfmlk can serve Alpha now/);
  const s = read();
  // the watchers go before anything is stopped, or they start it again
  const firstKill = s.log.findIndex((l) => l.startsWith('kill'));
  assert.ok(s.log.indexOf('disable Alpha Self-Heal') < firstKill, s.log.join(' | '));
  assert.ok(s.log.indexOf('disable Alpha Server - Health Guard') < firstKill);
  for (const n of ['Alpha Self-Heal', 'Alpha Server - Health Guard', 'Alpha Backend', 'Alpha', 'Cloudflared at logon']) assert.equal(taskState(s, n), 'Disabled', n);
  assert.equal(taskState(s, 'Alpha Doctor'), 'Ready', 'the doctor keeps running on a standby');
  assert.deepEqual(s.service, { status: 'Stopped', startType: 'Manual', exitCode: 0 });
  assert.deepEqual(s.listen, []);
  assert.deepEqual(s.procs.map((p) => p.ProcessId), [500]);
  const role = JSON.parse(readFileSync(join(ops, 'role.json'), 'utf8'));
  assert.equal(role.role, 'standby');
  assert.equal(role.primary, 'laptop-gj8dfmlk');
  const records = readdirSync(join(ops, 'standdown')).filter((f) => f.startsWith('standdown-'));
  assert.equal(records.length, 1);
  const record = readFileSync(join(ops, 'standdown', records[0]), 'utf8');
  assert.doesNotMatch(record + r.out, /SECRET-TOKEN/, 'a command line is never printed or saved');
  assert.match(r.out, /answers nothing: down until laptop-gj8dfmlk serves it/);
});

test('Alpha\'s own runtime is named and left to its Agent Manager; a stranger on the port is left alone', { skip }, () => {
  const state = serving();
  state.procs.push({ ProcessId: 800, ParentProcessId: 1, Name: 'powershell.exe', CommandLine: 'powershell -File C:\\Alpha\\scripts\\alpha_runtime_always_on.ps1' });
  let { run, read } = setup(state);
  let r = run();
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /Alpha's own runtime still runs here \(alpha_runtime_always_on\.ps1\)/);
  assert.ok(read().procs.some((p) => p.ProcessId === 800), 'never stopped from here');

  const other = serving();
  other.procs.push({ ProcessId: 900, ParentProcessId: 1, Name: 'java.exe', CommandLine: 'java' });
  other.listen.push({ port: 4173, pid: 900 });
  ({ run, read } = setup(other));
  r = run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /LEFT java 900 on 4173: not one of Alpha's/);
  assert.match(r.out, /RESULT: Alpha still serves here: java 900 listens/);
});

test('standing up again refuses while another machine serves, then restores exactly what was on', { skip }, () => {
  const state = serving();
  // Somebody had already turned the guard off: standing up must not turn it on.
  state.tasks.find((t) => t.name === 'Alpha Server - Health Guard').state = 'Disabled';
  const { ops, run, read, set } = setup(state);
  assert.equal(run().code, 0);

  set({ public: 200 });
  let r = run('-Undo');
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /REFUSED: https:\/\/alpha-ai\.uk\/ answers 200 and no connector runs here, so another machine serves Alpha/);
  assert.equal(taskState(read(), 'Alpha Backend'), 'Disabled');

  set({ public: 0, backendUp: true, log: [] });
  r = run('-Undo');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /RESULT: Alpha serves here again/);
  const s = read();
  for (const n of ['Alpha Backend', 'Alpha', 'Alpha Self-Heal', 'Cloudflared at logon']) assert.equal(taskState(s, n), 'Ready', n);
  assert.equal(taskState(s, 'Alpha Server - Health Guard'), 'Disabled', 'left as it was before the stand-down');
  assert.deepEqual(s.service, { status: 'Running', startType: 'Automatic', exitCode: 0 });
  // the servers come back before the watchers that would restart them
  assert.ok(s.log.indexOf('start-task Alpha Backend') < s.log.indexOf('enable Alpha Self-Heal'), s.log.join(' | '));
  assert.equal(existsSync(join(ops, 'role.json')), false);
  assert.ok(readdirSync(join(ops, 'standdown')).some((f) => f.startsWith('role-')), 'set aside, not deleted');

  // -Force is the override, for a person who knows the other one is stopping
  const again = setup(serving({ public: 200, backendUp: true, procs: serving().procs.filter((p) => p.Name !== 'cloudflared.exe') }));
  assert.equal(again.run('-Undo').code, 3);
  assert.equal(again.run('-Undo', '-Force').code, 0);
});

// The stand-up is the half that starts an Alpha, and alpha-standby.mjs drives
// it unattended, so its rehearsal is the one that must be unmistakable. Its
// header carried no report-only marker (the stand-down's does) and its WOULD
// was one fixed sentence that read neither the state nor the record.
test('the stand-up rehearsal says so, and reads the record instead of a fixed sentence', { skip }, () => {
  // Worker1's real shape on 2026-10-09: the connector service Stopped while a
  // cloudflared ran anyway, and the health guard already off before any of this.
  const state = serving({ service: { status: 'Stopped', startType: 'Automatic', exitCode: 0 } });
  state.tasks.find((t) => t.name === 'Alpha Server - Health Guard').state = 'Disabled';
  const { ops, run, read, set } = setup(state);
  assert.equal(run().code, 0, 'stand down for real, so there is a record to read');

  set({ log: [] });
  const before = JSON.stringify(read());
  const r = run('-Undo', '-ReportOnly');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ALPHA STAND-UP .*\(report only: nothing is changed\)/, 'not mistakable for a real stand-up');
  assert.match(r.out, /enable and start 'Alpha Backend'/);
  assert.match(r.out, /leave 'Alpha Server - Health Guard' disabled: the record says it was disabled/,
    'the fixed sentence promised to enable the watchers, including one the real path leaves off');
  assert.match(r.out, /leave it stopped: it was not running before the stand-down/,
    'and promised to restore a connector the real path deliberately does not start');
  assert.match(r.out, /set role\.json aside/);
  assert.equal(JSON.stringify(read()), before, 'a rehearsal changes nothing');
  assert.equal(existsSync(join(ops, 'role.json')), true, 'and leaves the standby marker where it was');

  // -StartConnector is what alpha-standby.mjs passes, and it is the one thing
  // that turns that line round.
  assert.match(run('-Undo', '-ReportOnly', '-StartConnector').out, /to start Automatic, and start it/);

  // The refusal exits before WOULD, so the header is the only thing left
  // saying this was a rehearsal and not a real stand-up that refused.
  set({ public: 200 });
  const ref = run('-Undo', '-ReportOnly');
  assert.equal(ref.code, 3, ref.out);
  assert.doesNotMatch(ref.out, /WOULD/);
  assert.match(ref.out, /\(report only: nothing is changed\)/, 'a refused rehearsal is still marked as one');
});

// 2026-10-10: Worker1 was stood down while its tasks were already off, and the
// stand-up read only that newest record, so it turned nothing back on and
// alpha-ai.uk stayed at 530. Every record since the last stand-up counts; one
// from before it does not; and the servers and self-heal come back regardless.
test('standing up reads every record since the last stand-up, and always brings Alpha back', { skip }, () => {
  const { ops, run, read, set } = setup(serving());
  const records = join(ops, 'standdown');
  const rename = (to) => {
    const f = readdirSync(records).find((n) => /^standdown-\d{8}-\d{6}\.json$/.test(n) && !n.startsWith('standdown-2000'));
    renameSync(join(records, f), join(records, to));
  };
  // Before the last stand-up: the guard was on. It must not count now.
  assert.equal(run().code, 0);
  rename('standdown-20000101-000000.json');
  writeFileSync(join(records, 'role-20000101-120000.json'), '{"role":"standby"}');
  // Since then: the guard off, the rest serving; then a second stand-down
  // that finds everything already off.
  const tasks = serving().tasks.map((t) => (t.name === 'Alpha Server - Health Guard' ? { ...t, state: 'Disabled' } : t));
  set({ ...serving(), tasks });
  assert.equal(run().code, 0);
  rename('standdown-20000102-000000.json');
  assert.equal(run().code, 0);
  assert.equal(taskState(read(), 'Alpha Backend'), 'Disabled');

  set({ backendUp: true, log: [] });
  const r = run('-Undo');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /record: standdown-20000102-000000\.json, standdown-\d{8}-\d{6}\.json/);
  assert.doesNotMatch(r.out, /20000101/);
  const s = read();
  for (const n of ['Alpha Backend', 'Alpha', 'Alpha Self-Heal', 'Cloudflared at logon']) assert.equal(taskState(s, n), 'Ready', n);
  assert.equal(taskState(s, 'Alpha Server - Health Guard'), 'Disabled', 'off since before the last stand-up');
  assert.deepEqual(s.service, { status: 'Running', startType: 'Automatic', exitCode: 0 }, 'as the first record since then saw it');

  // Only the record that saw everything off, and still: serving here is what
  // these three are.
  const bare = setup(serving());
  assert.equal(bare.run().code, 0);
  assert.equal(bare.run().code, 0);
  const names = readdirSync(join(bare.ops, 'standdown')).sort();
  if (names.length > 1) rmSync(join(bare.ops, 'standdown', names[0]));
  bare.set({ backendUp: true });
  assert.equal(bare.run('-Undo').code, 0);
  for (const n of ['Alpha Backend', 'Alpha', 'Alpha Self-Heal']) assert.equal(taskState(bare.read(), n), 'Ready', n);
  assert.equal(taskState(bare.read(), 'Cloudflared at logon'), 'Disabled', 'a connector task only comes back on a record');
});

// Worker1 as the rehearsal found it: the service Stopped (start Automatic)
// while a connector started some other way served. Restoring exactly would
// bring Alpha back with no way in; covering for a primary that is down needs one.
test('covering starts the connector whatever the record says, and says when it would not start', { skip }, () => {
  const state = serving({ service: { status: 'Stopped', startType: 'Automatic', exitCode: 1067 } });
  const { run, read, set } = setup(state);
  assert.equal(run().code, 0);
  set({ backendUp: true, log: [] });
  let r = run('-Undo');
  assert.match(r.out, /cloudflared start type back to Automatic; it was not running before, so not started/);

  const again = setup(serving({ service: { status: 'Stopped', startType: 'Automatic', exitCode: 1067 } }));
  assert.equal(again.run().code, 0);
  again.set({ backendUp: true, log: [] });
  r = again.run('-Undo', '-StartConnector');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /started cloudflared \(start Automatic\)/);
  assert.match(r.out, /connector: cloudflared runs here/);
  assert.equal(again.read().service.status, 'Running');

  const broken = setup(serving({ service: { status: 'Stopped', startType: 'Automatic', exitCode: 1067 }, serviceFails: true }));
  assert.equal(broken.run().code, 0);
  broken.set({ backendUp: true });
  r = broken.run('-Undo', '-StartConnector');
  assert.match(r.out, /CONNECTOR NOT RUNNING: cloudflared did not start a cloudflared, so alpha-ai\.uk stays down/);
  assert.match(r.out, /last exit code 1067/);
});
