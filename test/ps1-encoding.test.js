// Windows PowerShell 5.1 reads a .ps1 without a BOM as Windows-1252, not
// UTF-8. An em dash is E2 80 94 in UTF-8, and 0x94 in 1252 is a closing curly
// quote, which PowerShell accepts as a string terminator: fix-tunnel.ps1 died
// on the host with "Unexpected token '}'" before running a single check. The
// scripts are run by hand on that machine, so keep them plain ASCII.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { balance, unbalancedReason } from '../scripts/ps1-balance.mjs';

const SCRIPTS = new URL('../scripts/', import.meta.url);
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;

test('every PowerShell script is plain ASCII', async () => {
  const names = (await readdir(SCRIPTS)).filter((n) => n.endsWith('.ps1'));
  assert.ok(names.length > 0);
  for (const name of names) {
    const bytes = await readFile(new URL(name, SCRIPTS));
    const at = bytes.findIndex((b) => b > 0x7f);
    assert.equal(at, -1, `${join('scripts', name)} has a non-ASCII byte at offset ${at}`);
  }
});

// "$pub: the connector" is a parse error: PowerShell reads `$name:` as a
// drive- or scope-qualified variable and wants a name after the colon. One of
// these in repair-alpha-host.ps1 stopped the whole script before its first
// step, so the host never got its boot tasks. CI has no PowerShell to parse
// with, so look for the shape; write ${name}: instead.
test('no PowerShell script has a bare $name: before a non-name character', async () => {
  const names = (await readdir(SCRIPTS)).filter((n) => n.endsWith('.ps1'));
  const bad = [];
  for (const name of names) {
    const lines = (await readFile(new URL(name, SCRIPTS), 'utf8')).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      if (/\$[A-Za-z_][A-Za-z0-9_]*:(?![A-Za-z0-9_{\\:])/.test(line)) bad.push(`${join('scripts', name)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});

// The third shape worth checking without PowerShell, and the costliest to get
// wrong: an unbalanced brace. The heartbeat change wrapped about ninety lines
// of autopilot.ps1 in an if/else from a container with no PowerShell, which is
// exactly the edit that drops one -- and a parse error in that file stops the
// standing checks on both machines, with the script's own report being how
// anyone would have found out.
test('every PowerShell script balances its braces, parens and brackets', async () => {
  const names = (await readdir(SCRIPTS)).filter((n) => n.endsWith('.ps1'));
  assert.ok(names.length > 0);
  const bad = [];
  for (const name of names) {
    const reason = unbalancedReason(await readFile(new URL(name, SCRIPTS), 'utf8'));
    if (reason) bad.push(`${join('scripts', name)}: ${reason}`);
  }
  assert.deepEqual(bad, []);
});

// The counter is only worth having if it reads PowerShell the way PowerShell
// does. Each of these is a construct this repo actually writes, and each would
// make the check either useless or unusable if it were read as code.
test('the balance counter skips what PowerShell would not read as code', () => {
  const ok = (src) => assert.equal(unbalancedReason(src), null, src);
  // A subexpression inside a string is code again, and nests: the ) that closes
  // it hands control back to the string. autopilot.ps1 is full of this shape.
  ok('$a = "$(if ($x) { \'a\' } else { \'b\' })"');
  ok('$a = "value: $($h.Substring(0, [math]::Min(160, $h.Length)))"');
  // Braces in prose, which several of these scripts use to explain a brace.
  ok('# a lone { in a comment\n<# and a ) in a block comment #>\nif ($true) { 1 }');
  // A here-string full of brackets -- setup-host.mjs prints a systemd unit
  // this way and repair-alpha-host.ps1 embeds JSON.
  ok('$u = @"\n[Unit]\nExec=a ( b { c\n"@\nif ($true) { 1 }');
  ok("$j = @'\n{\"a\": [1, 2}\n'@\nif ($true) { 1 }");
  // A quote inside a string, both ways, and a backtick escaping a brace.
  ok("$a = 'it''s fine { '");
  ok('$a = "she said ""hi"" ("');
  ok('$a = "a `{ brace"');
  // And it still catches the thing it is for.
  assert.match(unbalancedReason('if ($true) { 1'), /1 unclosed \{/);
  assert.match(unbalancedReason('if ($true) { 1 }}'), /1 more \} than \{/);
  assert.match(unbalancedReason('$a = "unterminated'), /ends inside a double string/);
  // An open $( is an open ( too, so it is counted as one and located, not
  // reported separately.
  assert.match(unbalancedReason('$a = "$(1'), /1 unclosed \(, 1 of them a \$\( inside a string/);
});

// It is a brace counter, not a parser, and the comment above it says so. This
// pins that: a file can balance and still be wrong, so nobody reads a pass
// here as "the script runs".
test('balancing is not the same as parsing, and the check does not claim to be', () => {
  assert.equal(unbalancedReason('Get-Thing-That-Does-Not-Exist -NoSuchFlag'), null);
  assert.equal(balance('if ($true) { 1 }').mode, 'code');
});

// The counter above is not a parser, and on 2026-10-09 that cost thirty test
// failures to say one thing: a backtick typed inside a double-quoted string in
// laptop41-doctor.ps1's recommendation text ("`using the CPU`") is PowerShell's
// escape character, so `u began a unicode escape, the whole file stopped
// parsing, and every test in its suite failed with no hint which line did it.
// PowerShell's own parser says it in one line, and it needs no Windows.
test('every PowerShell script parses', { skip: hasPwsh ? false : 'PowerShell not found (set PWSH or put pwsh on PATH)' }, async () => {
  const names = (await readdir(SCRIPTS)).filter((n) => n.endsWith('.ps1'));
  assert.ok(names.length > 0);
  const dir = fileURLToPath(SCRIPTS);
  // One pwsh for all of them: starting it is most of the cost.
  const script = `
    $bad = @()
    foreach ($f in Get-ChildItem -LiteralPath '${dir}' -Filter *.ps1) {
      $e = $null
      [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$e)
      foreach ($x in @($e)) { $bad += "$($f.Name):$($x.Extent.StartLineNumber): $($x.Message)" }
    }
    $bad -join "\n"`;
  const r = spawnSync(PWSH, ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '', r.stdout);
});
