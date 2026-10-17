#!/usr/bin/env node
/**
 * Are a PowerShell script's braces, parentheses and brackets balanced?
 *
 * This repo's `.ps1` files are edited from cloud containers that have no
 * PowerShell to parse them with, and `scripts/autopilot.ps1` is the file where
 * that is most expensive: a parse error there stops the standing checks on both
 * machines, and the script's own report is how anyone would find out. The
 * heartbeat change on 2026-10-09 wrapped about ninety lines of it in an
 * `if`/`else`, which is exactly the edit that drops a brace.
 *
 * `test/ps1-encoding.test.js` already works this way and says why -- "CI has no
 * PowerShell to parse with, so look for the shape". Its two existing checks
 * each caught a real parse error that stopped a whole script before its first
 * step: a non-ASCII byte read as Windows-1252, and a bare `$name:` that
 * PowerShell reads as a drive-qualified variable.
 *
 * **It is not a parser, and must not be mistaken for one.** It says nothing
 * about a misspelled cmdlet, a wrong property, a bad type or an argument that
 * does not exist. A balanced file can still fail to run. What it covers is the
 * one class of error a structural edit most often introduces, and the only
 * class that can be judged without PowerShell at all.
 *
 * Usage:
 *   node scripts/ps1-balance.mjs scripts/*.ps1
 *
 * Exits 1 if any file is unbalanced, naming the counts.
 */

import { readFileSync } from 'node:fs';

const OPENERS = { '{': 0, '(': 0, '[': 0 };
const CLOSERS = { '}': '{', ')': '(', ']': '[' };

/**
 * Counts openers minus closers, skipping anything PowerShell would not read as
 * code. The modes are the whole of it:
 *
 * - `#` to end of line, and `<# ... #>` -- comments, where a stray brace is
 *   prose. Several of these scripts explain a brace in a comment.
 * - `'...'` -- single quotes take no escapes but double a quote to include one.
 * - `"..."` -- double quotes take a backtick escape, a doubled quote, and
 *   `$( ... )`, which is *code again* and nests: the `)` that closes it returns
 *   to the string, so the `"` after it ends the outer string and not an inner
 *   one. Getting that wrong is what would make this check unusable, because
 *   this repo writes `"$(if ($x) { 'a' } else { 'b' })"` constantly.
 * - `@"` / `@'` here-strings, whose terminator counts only at the start of a
 *   line. `setup-host.mjs` prints a systemd unit full of brackets this way, and
 *   `repair-alpha-host.ps1` embeds JSON.
 * - A backtick outside a string escapes the next character, brace included.
 */
export function balance(source) {
  const counts = { ...OPENERS };
  const src = String(source);
  const n = src.length;
  // The paren depth each open `$(` was seen at, so its `)` can hand control
  // back to the string that contained it.
  const subexpressions = [];
  let mode = 'code';
  let i = 0;
  while (i < n) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (mode === 'code') {
      if (two === '<#') { mode = 'block'; i += 2; continue; }
      if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '`') { i += 2; continue; }
      if ((two === '@"' || two === "@'") && /^\r?\n/.test(src.slice(i + 2, i + 4))) {
        mode = two === '@"' ? 'here-double' : 'here-single';
        i += 2;
        continue;
      }
      if (c === "'") { mode = 'single'; i++; continue; }
      if (c === '"') { mode = 'double'; i++; continue; }
      if (c in counts) { counts[c]++; i++; continue; }
      if (c in CLOSERS) {
        counts[CLOSERS[c]]--;
        if (c === ')' && subexpressions.length && subexpressions[subexpressions.length - 1] === counts['(']) {
          subexpressions.pop();
          mode = 'double';
        }
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (mode === 'block') {
      if (two === '#>') { mode = 'code'; i += 2; } else i++;
      continue;
    }
    if (mode === 'single') {
      if (c === "'" && src[i + 1] === "'") i += 2;
      else if (c === "'") { mode = 'code'; i++; }
      else i++;
      continue;
    }
    if (mode === 'double') {
      if (c === '`') { i += 2; continue; }
      if (c === '"' && src[i + 1] === '"') { i += 2; continue; }
      if (two === '$(') { subexpressions.push(counts['(']); counts['(']++; mode = 'code'; i += 2; continue; }
      if (c === '"') { mode = 'code'; i++; continue; }
      i++;
      continue;
    }
    // A here-string ends only with its terminator at the start of a line.
    const end = mode === 'here-single' ? "'@" : '"@';
    if (src.slice(i, i + 2) === end && (i === 0 || src[i - 1] === '\n' || src[i - 1] === '\r')) {
      mode = 'code';
      i += 2;
      continue;
    }
    i++;
  }
  return { counts, mode, openSubexpressions: subexpressions.length };
}

/** The reason a file is unbalanced, or null when it is fine. */
export function unbalancedReason(source) {
  const { counts, mode, openSubexpressions } = balance(source);
  const off = Object.entries(counts).filter(([, v]) => v !== 0);
  if (off.length) {
    // An open `$(` is always an open `(` too, so it is reported as part of the
    // paren count rather than on its own -- but saying where it is saves the
    // reader looking for a parenthesis that is inside a string.
    const where = openSubexpressions ? `, ${openSubexpressions} of them a $( inside a string` : '';
    return off.map(([open, v]) => (v > 0
      ? `${v} unclosed ${open}`
      : `${-v} more ${Object.keys(CLOSERS).find((k) => CLOSERS[k] === open)} than ${open}`)).join(', ') + where;
  }
  if (mode !== 'code') return `ends inside a ${mode.replace('-', ' ')} string or comment`;
  return null;
}

if (process.argv[1] && process.argv.length > 2) {
  let bad = 0;
  for (const file of process.argv.slice(2)) {
    const reason = unbalancedReason(readFileSync(file, 'utf8'));
    if (reason) { bad++; console.error(`${file}: ${reason}`); }
  }
  console.log(bad ? `${bad} file(s) unbalanced` : `${process.argv.length - 2} file(s) balanced`);
  process.exit(bad ? 1 : 0);
}
