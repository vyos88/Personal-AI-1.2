// The two things panel-endpoint.ps1 can be asked without a board, and both are
// about reading what came back off the wire rather than about serial itself.
//
// They exist because the failure this script actually hit was unreadable: COM7
// answered no STATUS for 30 s and the report could not say whether the board had
// said anything at all. `-ParseStatus` and `-DescribeHeard` are the seams that
// answer that, so they are pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'panel-endpoint.ps1');

// Needs PowerShell. Set PWSH to its path, or have pwsh on PATH; without it these
// are skipped, not failed — the same rule as test/autopilot.test.js.
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const skip = hasPwsh ? false : 'PowerShell not found (set PWSH)';

const run = (args) =>
  spawnSync(PWSH, ['-NoProfile', '-File', SCRIPT, ...args], { encoding: 'utf8' });

test("a STATUS line from Alpha's deck firmware is read field by field", { skip }, () => {
  const r = run(['-ParseStatus', '[crowpanel] fw=alpha-1 wifi_ssid=BT-house alpha_base=http://192.168.1.151:8001 alpha_set=yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    fw: 'alpha-1',
    wifi_ssid: 'BT-house',
    alpha_base: 'http://192.168.1.151:8001',
    alpha_set: 'yes',
  });

  // This firmware's own reply is not a STATUS line, and must not be read as one:
  // the two sketches are the mistake that actually happens, and a half-parsed
  // reply would have the script set ALPHA on a board that cannot take it.
  assert.equal(run(['-ParseStatus', '{"ok":true,"cmd":"status","firmware":"panel-4"}']).stdout.trim(), 'null');
  assert.equal(run(['-ParseStatus', 'ets Jul 29 2019 12:21:46']).stdout.trim(), 'null');
});

test('silence is described by what the port did send', { skip }, () => {
  // Nothing at all: the answer Worker1's COM7 gave on 2026-10-07, and the one
  // that sends somebody to the cable rather than to the firmware.
  assert.match(run(['-DescribeHeard', '']).stdout, /nothing at all came back/);

  // This repo's own firmware answering: talking, and not as Alpha's deck. The
  // quoted line is what makes that legible to whoever reads the report.
  const ours = run(['-DescribeHeard', '{"ok":false,"error":"bad json","cmd":""}\\n']).stdout;
  assert.match(ours, /talking, but not as Alpha's deck firmware/);
  assert.match(ours, /bad json/);

  // A real STATUS line is not silence at all.
  assert.match(run(['-DescribeHeard', '[crowpanel] fw=alpha-1 wifi_ssid=x\\n']).stdout, /^status: \[crowpanel\]/m);

  // Anything credential-shaped in what a board said is masked before it can
  // reach a report that leaves the machine.
  assert.match(run(['-DescribeHeard', 'wifi password=hunter2 ssid=x\\n']).stdout, /password=\*\*\*/);
});

test('a port can be given by hand, because a person at the board beats the pick', { skip }, () => {
  // The Espressif rule chose COM7 on Worker1; COM7 sent nothing for 30 s and the
  // board turned out to be on COM4. -Port skips the pick rather than arguing
  // with it. Off Windows the run stops at step 1 (no Get-NetIPAddress), so what
  // this can prove here is that the parameter exists and binds — a missing one
  // fails differently, and that difference is the regression worth catching.
  const given = run(['-Port', 'COM4']);
  assert.doesNotMatch(
    `${given.stdout}${given.stderr}`,
    /A parameter cannot be found that matches parameter name/,
    '-Port must be a real parameter of this script',
  );
  // It is still only a port name: the string reaches a SerialPort constructor.
  const bad = run(['-Port', 'COM4; calc']);
  assert.notEqual(bad.status, 0);
});
