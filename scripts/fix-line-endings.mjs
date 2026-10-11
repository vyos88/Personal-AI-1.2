#!/usr/bin/env node
/**
 * Finds Alpha source files whose line ends were doubled (CR CR LF) and puts
 * them back to CRLF.
 *
 * Until 2026-10-07 apply-alpha-update.mjs wrote them on Windows: `git apply`
 * already produced CRLF, and CRLF was added again. On Worker1 every line of
 * scripts\alpha_agent_manager.ps1 ended CR CR LF, so each PowerShell backtick
 * continuation stopped at the first CR, the next line ran as a command ("The
 * term '-ReceiptStatus' is not recognized"), and the Agent Manager stopped
 * writing its snapshot. Python reads the extra CR as an extra line end too.
 * The writer is fixed; this repairs what it, or anything like it, left behind.
 * The autopilot runs it every pass (`--fix`), so nobody has to.
 *
 *   node scripts/fix-line-endings.mjs --alpha-root <dir>          report only
 *   node scripts/fix-line-endings.mjs --alpha-root <dir> --fix    repair, after a backup
 *
 * What it will and will not touch:
 *   - Only the trees apply-alpha-update.mjs writes: Alpha's software\ and the
 *     scripts\ folder beside it. Never node_modules, venvs, dist or .git.
 *   - Only text files by extension, and never one that looks binary or UTF-16.
 *   - Only CR bytes. It works on raw bytes, so no encoding is ever decoded or
 *     re-encoded, and it checks that the file minus its CRs is unchanged
 *     before writing it.
 *   - Every original is copied to <ops>\backups\line-endings-<stamp> first.
 *
 * With --fix, a pass after the first rechecks only files changed since the
 * last pass (damage only arrives with a write), plus a full sweep once a day.
 *
 * Prints OK:, NOTE:, FIXED: and PROBLEM: lines. Exit 0 nothing to do; 1 damage
 * open or an error; 2 repaired in this run.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXTENSIONS = new Set([
  '.ps1', '.psm1', '.psd1', '.cmd', '.bat', '.vbs',
  '.py', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '.css', '.html', '.json', '.md', '.txt', '.yml', '.yaml', '.toml', '.ini', '.cfg',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'venv', '.venv', 'env', '__pycache__', 'dist', 'build', '.pytest_cache', '.mypy_cache']);
const MAX_BYTES = 20 * 1024 * 1024;
const FULL_SWEEP_MS = 24 * 3600_000;
const DOUBLED = /\r\r+\n/g;

/** The folder holding backend/ and frontend/: the root itself, or software/ under it. */
export function findSoftware(root) {
  for (const dir of [root, join(root, 'software')]) {
    if (existsSync(join(dir, 'backend', 'main.py')) || existsSync(join(dir, 'frontend', 'package.json'))) return dir;
  }
  return null;
}

/** The trees apply-alpha-update.mjs writes into, by the names it uses for them. */
export function areas(software) {
  return [
    { name: 'software', root: software },
    { name: 'scripts', root: join(dirname(software), 'scripts') },
  ].filter((a) => existsSync(a.root));
}

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name.toLowerCase())) yield* walk(path);
    } else if (e.isFile()) {
      const dot = e.name.lastIndexOf('.');
      if (dot > 0 && EXTENSIONS.has(e.name.slice(dot).toLowerCase())) yield path;
    }
  }
}

/** UTF-16 (by its BOM) or anything with a NUL byte near the start is not a text file to touch. */
export function looksBinary(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return true;
  return buf.subarray(0, 8192).includes(0);
}

/** Byte-exact: latin1 maps each byte to one character and back, so nothing but CRs can change. */
export function repairBytes(buf) {
  const text = buf.toString('latin1');
  const count = (text.match(DOUBLED) ?? []).length;
  if (!count) return { count: 0, fixed: buf };
  return { count, fixed: Buffer.from(text.replace(DOUBLED, '\r\n'), 'latin1') };
}

export function onlyCrChanged(before, after) {
  return before.toString('latin1').replace(/\r/g, '') === after.toString('latin1').replace(/\r/g, '');
}

/** Damaged files under the areas, optionally only those changed since `since` (ms). */
export function scan(list, { since = 0 } = {}) {
  const found = [];
  let checked = 0;
  for (const area of list) {
    for (const path of walk(area.root)) {
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.size > MAX_BYTES || st.mtimeMs < since) continue;
      let buf;
      try { buf = readFileSync(path); } catch { continue; }
      checked++;
      if (looksBinary(buf)) continue;
      const { count } = repairBytes(buf);
      if (count) found.push({ area: area.name, path, rel: relative(area.root, path), count });
    }
  }
  return { found, checked };
}

function writeAtomic(path, buf) {
  const tmp = `${path}.eolfix-${process.pid}.tmp`;
  writeFileSync(tmp, buf);
  try {
    renameSync(tmp, path);
  } catch {
    // Windows refuses to replace a file another process holds open; write in place instead.
    try { unlinkSync(tmp); } catch { /* nothing to leave behind in Alpha's tree */ }
    writeFileSync(path, buf);
  }
}

/** Repairs `found`, backing each original up under `backupDir` first. */
export function repair(found, backupDir) {
  const fixed = [];
  const problems = [];
  for (const f of found) {
    try {
      const before = readFileSync(f.path);
      const { count, fixed: after } = repairBytes(before);
      if (!count) continue;
      if (!onlyCrChanged(before, after)) throw new Error('the repair would change more than CR bytes');
      const backup = join(backupDir, f.area, f.rel);
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(f.path, backup);
      writeAtomic(f.path, after);
      if (repairBytes(readFileSync(f.path)).count) throw new Error('still doubled after writing');
      fixed.push({ ...f, count });
    } catch (error) {
      problems.push(`${f.area}${sep}${f.rel}: ${error.message}`);
    }
  }
  return { fixed, problems };
}

function parseArgs(argv) {
  const o = { fix: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--alpha-root') o.alphaRoot = next();
    else if (a === '--fix') o.fix = true;
    else if (a === '--ops') o.ops = next();
    else if (a === '--state') o.state = next();
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.alphaRoot) throw new Error('--alpha-root is required');
  return o;
}

export function main(argv = process.argv.slice(2), now = Date.now()) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.log(`PROBLEM: ${e.message}`); return 1; }
  const software = findSoftware(resolve(o.alphaRoot));
  if (!software) { console.log(`NOTE: no Alpha under ${o.alphaRoot}: nothing to check here`); return 0; }
  const list = areas(software);
  const ops = o.ops || (process.platform === 'win32' ? 'C:\\AlphaData\\alpha-ops' : join(process.env.HOME || '.', 'alpha-ops'));
  const statePath = o.state || join(ops, 'line-endings.json');

  // Report-only runs always look at everything; --fix runs look at what changed.
  let state = null;
  if (o.fix) { try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* first run */ } }
  const full = !state?.fullAt || now - Date.parse(state.fullAt) >= FULL_SWEEP_MS;
  // A minute of slack: a file written while the last pass was walking still counts.
  const since = full ? 0 : Math.max(0, Date.parse(state.scannedAt) - 60_000);

  const { found, checked } = scan(list, { since });
  const where = list.map((a) => a.root).join(' and ');
  const scope = full ? 'all' : 'changed';
  let code = 0;
  if (!found.length) {
    console.log(`OK: no doubled line ends in ${checked} ${scope} file(s) under ${where}`);
  } else if (!o.fix) {
    for (const f of found) console.log(`PROBLEM: ${f.area}${sep}${f.rel} has ${f.count} doubled line end(s) (CR CR LF)`);
    return 1;
  } else {
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    const backupDir = join(ops, 'backups', `line-endings-${stamp}`);
    const { fixed, problems } = repair(found, backupDir);
    for (const f of fixed) console.log(`FIXED: ${f.area}${sep}${f.rel} (${f.count} doubled line end(s) back to CRLF)`);
    if (fixed.length) console.log(`backup: ${backupDir}`);
    for (const p of problems) console.log(`PROBLEM: ${p}`);
    code = problems.length ? 1 : 2;
  }
  if (o.fix && code !== 1) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      scannedAt: new Date(now).toISOString(),
      fullAt: full ? new Date(now).toISOString() : state.fullAt,
    }, null, 1));
  }
  return code;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main();
