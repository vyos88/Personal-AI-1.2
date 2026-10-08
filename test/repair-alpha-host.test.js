// The one verification in repair-alpha-host.ps1 that could not tell an absence
// from a failure to look.
//
// `node src/admin/run.js agents 2>&1` folds stderr into the output, and the
// exit code was thrown away. So on a machine with no admin token the string is
// "Not signed in. Run `node src/admin/run.js login ...`" -- which does not
// match /jack/, and the script reported "No agent named like 'jack' is
// attached" and sent a person to set up a laptop that may have been attached
// the whole time. A scheduled run holds no token by default, so that was the
// usual case, not the rare one: it is what made the 08:19 pass on Laptop41
// exit 1.
//
// The decision is the exit code, which is why every case here pairs an output
// with one. `fail()` in src/admin/cli.js exits 1 for all four ways the question
// goes unanswered -- no token, a rejected saved sign-in, HTTP 401, and a
// coordinator that did not answer at all -- so the text is read only to say
// which, never to decide.
//
// `Read-AgentList` is the seam, exposed as `-ReadAgentList` the way
// panel-endpoint.ps1 exposes `-ParseStatus`, and answered before the script
// creates a directory or opens a transcript.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'repair-alpha-host.ps1');

// Needs PowerShell. Set PWSH to its path, or have pwsh on PATH; without it
// these are skipped, not failed -- the same rule as test/autopilot.test.js.
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const skip = hasPwsh ? false : 'PowerShell not found (set PWSH)';

const read = (output, exitCode = 0) => {
  const r = spawnSync(
    PWSH,
    ['-NoProfile', '-File', SCRIPT, '-ReadAgentList', output, '-ReadAgentListExitCode', String(exitCode)],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

const ROSTER = [
  'ID        NAME         OWNER   TYPES                     IDLE',
  'ag_01hx   jack-laptop  jack@x  alpha.coordination,grow   4s',
  'ag_01hy   worker1      vyo@x   alpha.music,grow          1s',
].join('\n');

test('an attached agent is found by name', { skip }, () => {
  assert.deepEqual(read(ROSTER, 0), { asked: true, found: true, reason: '' });
});

test('a roster without Jack is an answer, not a failure to ask', { skip }, () => {
  const without = ROSTER.split('\n').filter((line) => !line.includes('jack')).join('\n');
  assert.deepEqual(read(without, 0), { asked: true, found: false, reason: '' });
});

test('"Not signed in" is a check that could not run, never an empty fleet', { skip }, () => {
  // Verbatim from the 20261008-03-repair-host pass on Laptop41, PowerShell's
  // "node :" stderr prefix and all.
  const verdict = read(
    [
      'node : Not signed in. Run `node src/admin/run.js login --email <your email>` once (or set ALPHA_ADMIN_TOKEN, or',
      'ALPHA_BOOTSTRAP_TOKEN on a fresh install).',
      'At C:\\services\\alpha-tunnel\\scripts\\repair-alpha-host.ps1:561 char:11',
    ].join('\n'),
    1,
  );
  assert.equal(verdict.asked, false);
  assert.equal(verdict.found, false);
  assert.match(verdict.reason, /not signed in to the coordinator/);
});

test('each of the other ways the question goes unanswered says which', { skip }, () => {
  const saved = read('Your saved sign-in is no longer accepted (expired or ended). Run `login` again.', 1);
  assert.equal(saved.asked, false);
  assert.match(saved.reason, /saved sign-in was rejected/);

  const rejected = read('GET /agents failed: HTTP 401 - invalid token', 1);
  assert.equal(rejected.asked, false);
  assert.match(rejected.reason, /rejected the key \(401\)/);

  // The one that matters most on this fleet, and the one keyword matching
  // missed entirely: the coordinator is simply down, which is the whole
  // premise of the standby. The exit code catches it and the CLI's own line
  // is handed back rather than a guess.
  const down = read('GET /agents failed: fetch failed', 1);
  assert.equal(down.asked, false);
  assert.match(down.reason, /exited 1/);
  assert.match(down.reason, /fetch failed/);

  // A non-zero exit that printed nothing still says it could not ask.
  const mute = read('', 1);
  assert.equal(mute.asked, false);
  assert.match(mute.reason, /exited 1/);
});

test('a roster that happens to contain a number is not read as a 401', { skip }, () => {
  // Why the decision is the exit code and not the text: 401 free MB, or an id
  // with 401 in it, is a perfectly ordinary roster.
  const verdict = read(['ID        NAME     OWNER   MEM  IDLE', 'ag_401ab  jack-x   jack@x  401  2s'].join('\n'), 0);
  assert.deepEqual(verdict, { asked: true, found: true, reason: '' });
});

test('a clean exit that printed nothing is not an empty roster', { skip }, () => {
  // An `agents` call that printed nothing answered nothing. The real
  // empty-fleet case still prints the table's header row.
  for (const output of ['', '   \n  \n']) {
    const verdict = read(output, 0);
    assert.equal(verdict.asked, false, JSON.stringify(output));
    assert.match(verdict.reason, /printed nothing/, JSON.stringify(output));
  }
});

test('an exit 0 the matcher does not recognise is still an answer', { skip }, () => {
  // A clean exit means the CLI answered, whatever it chose to print. Treating
  // unfamiliar wording as unaskable would turn every future rewording into
  // "could not check" forever -- the mirror of the bug above.
  assert.deepEqual(read('no agents attached', 0), { asked: true, found: false, reason: '' });
});
