// Windows PowerShell 5.1 reads a .ps1 without a BOM as Windows-1252, not
// UTF-8. An em dash is E2 80 94 in UTF-8, and 0x94 in 1252 is a closing curly
// quote, which PowerShell accepts as a string terminator: fix-tunnel.ps1 died
// on the host with "Unexpected token '}'" before running a single check. The
// scripts are run by hand on that machine, so keep them plain ASCII.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SCRIPTS = new URL('../scripts/', import.meta.url);

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
