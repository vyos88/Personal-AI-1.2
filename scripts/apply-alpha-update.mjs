#!/usr/bin/env node
/**
 * Brings what has merged to Alpha's `alpha-full` branch into the Alpha that
 * actually runs on this machine, without replacing anything else.
 *
 * The running Alpha is a local working copy that is not in git, and
 * `alpha-full` is an older snapshot of it. Copying files across would put that
 * month-old snapshot over whatever changed here since. So this applies the
 * *changes* instead: it fetches `alpha-full`, takes the diff from the last
 * commit applied here (`--from`) to the branch tip, and applies it with
 * `git apply`, which needs only the edited lines and their context to match.
 * A difference elsewhere in a file does not matter.
 *
 * It refuses rather than guesses. Every file is checked first, and if any one
 * change does not apply cleanly, nothing is written. Before writing, every file
 * it will touch is copied to <ops>/backups, and the frontend is rebuilt. A
 * failed build, or a Python file that no longer parses, puts everything back
 * on the spot. Line endings (CRLF) and a UTF-8 BOM are kept per file.
 *
 * One kind of file comes whole rather than as a change: one the branch holds,
 * this machine has never had, and a script this update writes imports. Without
 * it the build fails (missingImports below says how a branch comes to hold
 * one). Each is listed with the file that imports it.
 *
 *   node scripts/apply-alpha-update.mjs --alpha-root <dir>            report: changes nothing
 *   node scripts/apply-alpha-update.mjs --alpha-root <dir> --apply    apply, rebuild
 *   node scripts/apply-alpha-update.mjs --alpha-root <dir> --apply --restart
 *   node scripts/apply-alpha-update.mjs --rollback <backup dir>       undo an apply
 *
 * --alpha-root is the folder that holds Alpha's backend\main.py and
 * frontend\package.json, or any folder above it (it looks two levels down,
 * including software\). Alpha is a private repository, so the fetch uses this
 * machine's own git credentials. Nothing from Alpha is stored in this repo.
 *
 * The scripts\ folder beside software\ (the stewards, the Agent Manager) is
 * updated the same way, when it exists. It keeps its own last-applied commit,
 * because runs before 2026-10-05 updated software\ only. If the live scripts
 * have drifted and refuse, --skip-scripts updates software\ alone.
 *
 * --branch <name> follows another branch than alpha-full, with its own record
 * of what was applied (<ops>/applied-<name>.json), so alpha-full's record is
 * never moved by it. The first run on such a branch needs --from: the commit
 * this machine matches (for a branch built on alpha-from-host-*, that
 * snapshot's commit).
 *
 * Other options: --from <commit>  --to <branch|commit>  --repo <url>
 *   --ops <dir> (default C:\AlphaData\alpha-ops)  --python <exe>  --skip-build
 *   --skip-scripts
 *
 * Exit codes: 0 done or nothing to do; 2 refused (a change does not apply),
 * nothing written; 1 could not run, or applied and then rolled back.
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULTS = {
  repo: 'https://github.com/vyos88/Alpha',
  branch: 'alpha-full',
  // alpha-full before the first change made from a cloud session for this
  // host (Alpha #36, 2026-10-04). Later runs start from the commit recorded in
  // <ops>/alpha-full-applied.json instead.
  from: '872a06a66c9428bc8d5c2a6ce7d6d1c8b8e39b00',
  subdir: 'BuildArtifacts/installers/Alpha-Full/software',
  scriptsSubdir: 'BuildArtifacts/installers/Alpha-Full/scripts',
  ops: platform() === 'win32' ? 'C:\\AlphaData\\alpha-ops' : join(homedir(), 'alpha-ops'),
};

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_REFUSED = 2;

export function parseArgs(argv) {
  const opts = { apply: false, restart: false, skipBuild: false, skipScripts: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--apply') opts.apply = true;
    else if (a === '--restart') opts.restart = true;
    else if (a === '--skip-build') opts.skipBuild = true;
    else if (a === '--skip-scripts') opts.skipScripts = true;
    else if (a === '--alpha-root') opts.alphaRoot = next();
    else if (a === '--from') opts.from = next();
    else if (a === '--to') opts.to = next();
    else if (a === '--branch') opts.branch = next();
    else if (a === '--repo') opts.repo = next();
    else if (a === '--ops') opts.ops = next();
    else if (a === '--python') opts.python = next();
    else if (a === '--rollback') opts.rollback = next();
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

function git(args, { cwd, input, allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`git not found: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return r;
}

/** The folder holding backend/main.py and frontend/package.json. */
export function findSoftwareRoot(start) {
  const root = resolve(start);
  const candidates = [root, join(root, 'software')];
  for (const c of [...candidates]) candidates.push(join(c, 'Alpha-Full', 'software'));
  return candidates.find((c) =>
    existsSync(join(c, 'backend', 'main.py')) && existsSync(join(c, 'frontend', 'package.json'))) ?? null;
}

/** A bare, blob-less clone: commits and trees only, file contents on demand. */
export function fetchBranch({ cache, repo, branch }) {
  if (!existsSync(join(cache, 'HEAD'))) {
    mkdirSync(dirname(cache), { recursive: true });
    git(['clone', '--bare', '--filter=blob:none', '--single-branch', '--branch', branch, repo, cache]);
  } else {
    git(['fetch', '--filter=blob:none', repo, `+refs/heads/${branch}:refs/heads/${branch}`], { cwd: cache });
  }
}

export function resolveCommit(cache, ref) {
  const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: cache, allowFail: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The changes under subdir between two commits, as a patch and a file list. */
export function buildPatch({ cache, from, to, subdir }) {
  const rel = `--relative=${subdir}`;
  // --no-renames, as for the file list: a rename is a delete and an add, so
  // a renamed file this machine never had is a delete already done plus a new
  // file, not a rename of a missing file (Worker1, jobs 29 and 32).
  const patch = git(['diff', '--no-color', '--no-ext-diff', '--no-renames', rel, from, to, '--', subdir], { cwd: cache }).stdout;
  const files = git(['diff', '--name-status', '--no-renames', rel, from, to, '--', subdir], { cwd: cache }).stdout
    .split('\n').filter(Boolean).map((line) => {
      const [status, path] = line.split('\t');
      return { status: status[0], path };
    });
  return { patch, files };
}

// `from '…'`, `import '…'`, `import('…')`, `require('…')` naming a relative
// path. Comments are not stripped: an import named only in a comment brings,
// at worst, a file the branch already holds.
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\1/g;
const SCRIPT_FILE = /\.(?:[cm]?js|jsx|tsx?)$/;
const IMPORT_SUFFIXES = ['', '.js', '.jsx', '.mjs', '.ts', '.tsx', '/index.js', '/index.jsx'];

export function relativeImports(text) {
  return [...text.matchAll(RELATIVE_IMPORT)].map((m) => m[2]);
}

/**
 * Files this update's scripts import that this machine has never had.
 *
 * A host branch is built from an alpha-from-host-* snapshot, which records
 * the host's copy of every file alpha-full tracks and leaves the ones the host
 * lacks as alpha-full has them. So the branch can hold a file the host never
 * got, no diff ever carries it, and the first change that imports it fails the
 * build: Worker1, 2026-10-06, vite.config.js importing ./musicBridge.js. Such a
 * file is brought whole from the target commit, but only when the branch
 * holds it, the host lacks it, and something this update writes imports it.
 */
export function missingImports({ cache, to, subdir, root, files }) {
  const tracked = new Set(git(['ls-tree', '-r', '--name-only', to, '--', subdir], { cwd: cache }).stdout
    .split('\n').filter(Boolean).map((p) => p.slice(subdir.length + 1)));
  const seen = new Set(files.map((f) => f.path));
  const queue = files.filter((f) => f.status !== 'D' && SCRIPT_FILE.test(f.path)).map((f) => f.path);
  const found = [];
  while (queue.length && found.length < 50) {
    const path = queue.shift();
    const shown = git(['show', `${to}:${subdir}/${path}`], { cwd: cache, allowFail: true });
    if (shown.status !== 0) continue;
    for (const spec of relativeImports(shown.stdout)) {
      const base = posix.normalize(posix.join(posix.dirname(path), spec));
      if (base.startsWith('..')) continue;
      const hit = IMPORT_SUFFIXES.map((s) => base + s).find((p) => tracked.has(p));
      if (!hit || seen.has(hit)) continue;
      seen.add(hit);
      if (existsSync(join(root, hit))) continue;
      found.push({ status: 'A', path: hit, note: `imported by ${path}; never on this machine` });
      if (SCRIPT_FILE.test(hit)) queue.push(hit);
    }
  }
  return found;
}

/** Those files as a patch that creates them. */
export function newFilesPatch({ cache, to, subdir, paths }) {
  const empty = git(['hash-object', '-t', 'tree', '--stdin'], { cwd: cache, input: '' }).stdout.trim();
  return git(['diff', '--no-color', '--no-ext-diff', `--relative=${subdir}`, empty, to, '--',
    ...paths.map((p) => `${subdir}/${p}`)], { cwd: cache }).stdout;
}

// Any run of CRs before a newline is one line end. `\r\r\n` is what this file
// used to write; reading it as one line end lets the next update heal it.
const toLf = (text) => text.replace(/\r+\n/g, '\n');

export function readLive(file) {
  const raw = readFileSync(file);
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const text = raw.subarray(bom ? 3 : 0).toString('utf8');
  return { bom, crlf: text.includes('\r\n'), text: toLf(text) };
}

/**
 * Writes `text` with the file's own line endings, whatever endings `text`
 * arrives with. It used to trust that the text was LF, and the patched files
 * are not: on Windows `git apply` writes CRLF into the scratch tree. So an LF
 * file came back CRLF, and a CRLF file came back CR-CR-LF, which breaks every
 * PowerShell backtick continuation (Worker1's alpha_agent_manager.ps1, written
 * 2026-10-06 11:48: "The term '-ReceiptStatus' is not recognized").
 */
export function writeLive(file, text, { bom = false, crlf = false } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const lf = toLf(text);
  const body = Buffer.from(crlf ? lf.replace(/\n/g, '\r\n') : lf, 'utf8');
  writeFileSync(file, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body);
}

/**
 * Copies the live files the patch touches into a scratch tree, LF-normalised,
 * and asks git file by file: does it apply, is it already applied, or neither.
 */
export function plan({ root, patch, files }) {
  const stage = mkdtempSync(join(tmpdir(), 'alpha-update-'));
  const patchFile = join(stage, '.update.patch');
  writeFileSync(patchFile, patch);
  const tree = join(stage, 'tree');
  const meta = {};
  for (const f of files) {
    const live = join(root, f.path);
    if (existsSync(live)) {
      const r = readLive(live);
      meta[f.path] = { bom: r.bom, crlf: r.crlf, existed: true };
      writeLive(join(tree, f.path), r.text);
    } else {
      meta[f.path] = { bom: false, crlf: false, existed: false };
    }
  }
  mkdirSync(tree, { recursive: true });
  const check = (path, reverse) => git(
    ['apply', '--check', ...(reverse ? ['-R'] : []), `--include=${path}`, patchFile],
    { cwd: tree, allowFail: true },
  );
  const rows = files.map((f) => {
    if (check(f.path, false).status === 0) return { ...f, state: 'applies' };
    if (check(f.path, true).status === 0) return { ...f, state: 'already' };
    const why = check(f.path, false).stderr.trim().split('\n')[0];
    return { ...f, state: 'conflict', why };
  });
  return { stage, tree, patchFile, rows, meta };
}

/**
 * Every Python worth trying, as [command, ...leading args]: the one named
 * with --python, Alpha's own backend venv, then the newest the launcher has.
 * Worker1's backend runs a newer Python than plain `py` picked, and its live
 * main.py uses syntax that older one cannot read (job 38: "line 18004:
 * invalid syntax", 2300 lines from any change), so one interpreter is not
 * enough to judge a merge.
 */
export function pythonCandidates(given, softwareRoot) {
  const list = [];
  if (given) list.push([given]);
  const win = platform() === 'win32';
  for (const venv of ['venv', '.venv']) {
    const exe = join(softwareRoot ?? '', 'backend', venv, win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python');
    if (softwareRoot && existsSync(exe)) list.push([exe]);
  }
  if (win) list.push(['py', '-3.14'], ['py', '-3.13'], ['py', '-3.12'], ['py'], ['python']);
  else list.push(['python3'], ['python']);
  return list;
}

function pythonParses(python, file) {
  // The line number, never the line's text: the report is pushed to the tunnel.
  const [cmd, ...pre] = Array.isArray(python) ? python : [python];
  const code = 'import ast,sys\ntry: ast.parse(open(sys.argv[1], encoding="utf-8-sig").read())\nexcept SyntaxError as e: sys.exit("line %s: %s" % (e.lineno, e.msg))';
  const r = spawnSync(cmd, [...pre, '-c', code, file], { encoding: 'utf8' });
  const last = `${r.stderr || ''}`.trim().split('\n').pop();
  return { ok: r.status === 0, detail: last, line: Number(/^line (\d+):/.exec(last)?.[1]) || null };
}

/**
 * Where a broken line sits among the changes the patch made to one file:
 * inside a hunk, or how far from the nearest one. A file that applied cleanly
 * but no longer parses means a hunk landed beside code that changed here.
 */
export function nearestHunk(patch, path, line, applyLog = '') {
  const hunks = [];
  let inFile = false;
  for (const l of patch.split('\n')) {
    if (l.startsWith('diff --git ')) inFile = l === `diff --git a/${path} b/${path}`;
    const m = inFile && /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m) hunks.push({ n: hunks.length + 1, start: Number(m[1]), end: Number(m[1]) + Number(m[2] ?? 1) - 1, offset: 0 });
  }
  // `git apply -v` names each hunk it had to place elsewhere in this
  // machine's copy: "Hunk #3 succeeded at 17990 (offset 2300 lines)." Line
  // numbers in the merged file are where the hunks landed, not where the
  // branch has them.
  let current = null;
  for (const l of applyLog.split('\n')) {
    const checking = /^Checking patch (.+)\.\.\.$/.exec(l.trim());
    if (checking) { current = checking[1]; continue; }
    const moved = current === path && /^Hunk #(\d+) succeeded at \d+ \(offset (-?\d+) lines?\)/.exec(l.trim());
    const h = moved && hunks[Number(moved[1]) - 1];
    if (h) { h.offset = Number(moved[2]); h.start += h.offset; h.end += h.offset; }
  }
  if (!hunks.length || !line) return null;
  const label = (h) => `change #${h.n} at lines ${h.start}-${h.end}${h.offset ? `, placed ${Math.abs(h.offset)} line(s) ${h.offset > 0 ? 'later' : 'earlier'} than on the branch` : ''}`;
  const inside = hunks.find((h) => line >= h.start && line <= h.end);
  if (inside) return `inside ${label(inside)}`;
  const dist = (h) => Math.min(Math.abs(line - h.start), Math.abs(line - h.end));
  const near = hunks.reduce((a, h) => (dist(h) < dist(a) ? h : a));
  return `${dist(near)} line(s) from ${label(near)}`;
}

function findPowerShell() {
  for (const name of platform() === 'win32' ? ['powershell', 'pwsh'] : ['pwsh']) {
    const r = spawnSync(name, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (r.status === 0) return name;
  }
  return null;
}

function powerShellParses(ps, file) {
  // The path goes in through the environment, never into the command text
  // (-Command joins extra arguments into the script rather than passing them).
  const code = '$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseFile($env:ALPHA_PARSE_FILE,[ref]$t,[ref]$e);if($e.Count){$e[0].Message;exit 1}';
  const r = spawnSync(ps, ['-NoProfile', '-Command', code], { encoding: 'utf8', env: { ...process.env, ALPHA_PARSE_FILE: file } });
  return { ok: r.status === 0, detail: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0] };
}

function npm(args, cwd) {
  // npm on Windows is npm.cmd, which cannot be spawned without a shell. The
  // arguments here are fixed strings, never input.
  const win = platform() === 'win32';
  const r = spawnSync(win ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', shell: win, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, tail: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n') };
}

// npm ci deletes node_modules before installing. On a host where Alpha's
// frontend is running, Windows refuses to delete a native module it has loaded
// (EPERM on rolldown-binding.win32-x64-msvc.node, Worker1, 2026-10-06), so an
// update that changed no package failed and was rolled back. Reinstall only
// when the packages changed or are missing; otherwise just build.
const PACKAGE_FILES = new Set(['frontend/package.json', 'frontend/package-lock.json']);
export function needsPackageInstall(fe, touchedPaths) {
  return !existsSync(join(fe, 'node_modules')) || touchedPaths.some((p) => PACKAGE_FILES.has(p));
}

// An npm ci that failed half way (that same EPERM) leaves node_modules
// partly deleted: the build then cannot even find vite (Worker1, job
// 20261006-13). `npm ls` says whether the installed tree is whole.
function packagesIntact(fe) {
  return npm(['ls', '--depth=0', '--silent'], fe).ok;
}

// The frontend Alpha serves runs from node_modules (vite preview), so a
// reinstall must stop it first and start it again after. Only node processes
// running from this frontend's node_modules are stopped.
function stopFrontend(fe, log) {
  if (platform() !== 'win32') return false;
  const dir = join(fe, 'node_modules').replace(/'/g, "''");
  const ps = findPowerShell();
  if (!ps) { log('  note: no PowerShell to stop the running frontend; npm ci may be refused'); return false; }
  const script = `$d='${dir}'; $n=0; Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; Start-Sleep -Seconds 2; Write-Output $n`;
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  const n = Number(String(r.stdout || '').trim().split(/\s+/).pop()) || 0;
  log(`  stopped ${n} frontend process(es) so packages can be reinstalled`);
  return true;
}

function startFrontend(log) {
  if (platform() !== 'win32') return;
  // Its wrapper may still count as running after its node was stopped.
  spawnSync('schtasks', ['/End', '/TN', 'Alpha'], { encoding: 'utf8' });
  const r = spawnSync('schtasks', ['/Run', '/TN', 'Alpha'], { encoding: 'utf8' });
  log(r.status === 0 ? "  started task 'Alpha' (frontend) again" : `  could not start task 'Alpha': ${(r.stderr || r.stdout).trim()}; the self-heal task restarts it`);
}

/**
 * Installs packages when they changed, are missing or are damaged, then
 * builds. Returns {ok, why, stopped}: `stopped` says the running frontend
 * was stopped and must be started again by the caller.
 */
function installAndBuild(fe, touchedPaths, log) {
  let mode = needsPackageInstall(fe, touchedPaths) ? 'ci' : 'none';
  if (mode === 'none' && !packagesIntact(fe)) {
    log('  installed frontend packages are incomplete (an earlier install was cut short): reinstalling');
    mode = 'ci';
  }
  let stopped = false;
  if (mode === 'ci') {
    stopped = stopFrontend(fe, log);
    log('  installing frontend packages (npm ci) and building...');
    const ci = npm(['ci', '--no-audit', '--no-fund'], fe);
    if (!ci.ok) return { ok: false, why: `npm ci failed:\n${ci.tail}`, stopped };
  } else {
    log('  packages unchanged and installed: building (no npm ci)...');
  }
  const build = npm(['run', 'build'], fe);
  return build.ok ? { ok: true, stopped } : { ok: false, why: `the frontend build failed:\n${build.tail}`, stopped };
}

/** Puts every file in a backup back, and removes the ones the apply added. */
export function rollback(backupDir, log = console.log) {
  const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
  // Backups from before scripts\ was handled have one area, at the top level.
  const areas = manifest.areas ?? [{ name: '', root: manifest.softwareRoot, changed: manifest.changed, added: manifest.added }];
  for (const area of areas) {
    for (const path of area.changed) {
      cpSync(join(backupDir, 'files', area.name, path), join(area.root, path));
    }
    for (const path of area.added) rmSync(join(area.root, path), { force: true });
    log(`  restored ${area.changed.length} file(s), removed ${area.added.length} added file(s) under ${area.root}`);
  }
  return manifest;
}

// Each task and the port its server listens on. `schtasks /End` ends the
// task's cmd.exe and leaves the server it started holding the port, so the
// task's next run cannot bind and the OLD server keeps serving: on Worker1,
// 2026-10-06, the rebuilt pages showed (they are read from disk) but
// vite.config.js's new /music routes did not (the preview server reads its
// config once, at start). Whatever listens on the port goes too.
export const RESTART_TASKS = [
  { task: 'Alpha Backend', port: 8001 },
  { task: 'Alpha', port: 4173 },
];

export function restartWindows(log, { spawn = spawnSync, isWindows = platform() === 'win32', tasks = RESTART_TASKS } = {}) {
  if (!isWindows) { log('  --restart only does something on the Windows host; restart Alpha by hand.'); return; }
  for (const { task, port } of tasks) {
    const q = spawn('schtasks', ['/Query', '/TN', task], { encoding: 'utf8' });
    if (q.status !== 0) { log(`  no scheduled task '${task}': restart it by hand`); continue; }
    spawn('schtasks', ['/End', '/TN', task], { encoding: 'utf8' });
    const held = spawn('powershell.exe', ['-NoProfile', '-Command',
      `@(Get-NetTCPConnection -LocalPort ${port} -State Listen -EA SilentlyContinue | ForEach-Object OwningProcess) -join ' '`], { encoding: 'utf8' });
    const pids = String(held.stdout || '').trim().split(/\s+/).filter((pid) => /^\d+$/.test(pid) && pid !== '0' && pid !== '4');
    for (const pid of new Set(pids)) {
      const k = spawn('taskkill.exe', ['/T', '/F', '/PID', pid], { encoding: 'utf8' });
      log(k.status === 0 ? `  stopped pid ${pid}, which held port ${port}` : `  could not stop pid ${pid} on port ${port}`);
    }
    const r = spawn('schtasks', ['/Run', '/TN', task], { encoding: 'utf8' });
    log(r.status === 0 ? `  restarted task '${task}'` : `  could not start '${task}': ${(r.stderr || r.stdout).trim()}`);
  }
  log('  Check http://127.0.0.1:8001/health and the site in a minute. The self-heal task also restarts anything left down.');
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { log(`STOP: ${e.message}`); return EXIT_ERROR; }

  if (opts.rollback) {
    const manifest = rollback(resolve(opts.rollback), log);
    if (!opts.skipBuild && manifest.frontendTouched) {
      const fe = join(manifest.softwareRoot, 'frontend');
      log('  rebuilding the frontend from the restored files');
      const touched = (manifest.areas?.[0] ? [...manifest.areas[0].changed, ...manifest.areas[0].added] : []);
      const built = installAndBuild(fe, touched, log);
      log(built.ok ? '  ok: frontend rebuilt' : `  frontend rebuild failed:\n${built.why}`);
      if (built.stopped && !opts.restart) startFrontend(log);
    }
    if (opts.restart) restartWindows(log);
    return EXIT_OK;
  }

  if (!opts.alphaRoot) { log('STOP: pass --alpha-root <folder that holds Alpha>'); return EXIT_ERROR; }
  const softwareRoot = findSoftwareRoot(opts.alphaRoot);
  if (!softwareRoot) {
    log(`STOP: no backend/main.py with frontend/package.json under ${opts.alphaRoot}`);
    return EXIT_ERROR;
  }
  log(`Alpha: ${softwareRoot}`);

  const ops = resolve(opts.ops ?? DEFAULTS.ops);
  const branch = opts.branch ?? DEFAULTS.branch;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes('..')) {
    log(`STOP: ${branch} is not a branch name`);
    return EXIT_ERROR;
  }
  // Each branch keeps its own record. A side branch (a host's live code plus
  // fixes) must never move alpha-full's: the next alpha-full update would then
  // start from the side branch and undo everything only this host has.
  const statePath = appliedStatePath(ops, branch);
  const recorded = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  if (branch !== DEFAULTS.branch && !opts.from && !recorded) {
    log(`STOP: the first update from ${branch} needs --from <the commit this machine matches>; alpha-full's starting point would undo what only this machine has.`);
    return EXIT_ERROR;
  }
  const cache = join(ops, 'alpha-full-cache.git');
  try {
    fetchBranch({ cache, repo: opts.repo ?? DEFAULTS.repo, branch });
  } catch (e) {
    log(`STOP: could not fetch ${branch}: ${e.message}`);
    log('  Alpha is a private repository: this machine needs git credentials for github.com (sign in once with `git credential-manager` or `gh auth login`).');
    return EXIT_ERROR;
  }
  const from = resolveCommit(cache, opts.from ?? recorded?.to ?? DEFAULTS.from);
  const to = resolveCommit(cache, opts.to ?? branch);
  if (!from || !to) { log(`STOP: cannot resolve ${!from ? 'the --from commit' : 'the --to commit'} in ${branch}`); return EXIT_ERROR; }
  log(`changes: ${from.slice(0, 7)}..${to.slice(0, 7)} of ${branch}${recorded ? ` (last applied here: ${recorded.to.slice(0, 7)})` : ''}`);

  const areas = [{ name: 'software', root: softwareRoot, from, ...buildPatch({ cache, from, to, subdir: DEFAULTS.subdir }) }];
  const scriptsRoot = join(dirname(softwareRoot), 'scripts');
  let scriptsTo = recorded?.scripts_to ?? null;
  if (opts.skipScripts) {
    log('  scripts: skipped (--skip-scripts)');
  } else if (!existsSync(scriptsRoot)) {
    log(`  scripts: no ${scriptsRoot} here, skipped`);
  } else {
    const scriptsFrom = resolveCommit(cache, opts.from ?? recorded?.scripts_to ?? (branch === DEFAULTS.branch ? DEFAULTS.from : recorded?.to));
    if (!scriptsFrom) { log('STOP: cannot resolve the commit scripts were last updated from'); return EXIT_ERROR; }
    areas.push({ name: 'scripts', root: scriptsRoot, from: scriptsFrom, ...buildPatch({ cache, from: scriptsFrom, to, subdir: DEFAULTS.scriptsSubdir }) });
    scriptsTo = to;
  }
  for (const area of areas) {
    const subdir = area.name === 'software' ? DEFAULTS.subdir : DEFAULTS.scriptsSubdir;
    const extra = missingImports({ cache, to, subdir, root: area.root, files: area.files });
    if (!extra.length) continue;
    area.patch += newFilesPatch({ cache, to, subdir, paths: extra.map((f) => f.path) });
    area.files.push(...extra);
  }
  const live = areas.filter((area) => area.files.length);
  if (!live.length) { log(`ok: nothing new on ${branch} since the last apply`); writeState(statePath, to, scriptsTo); return EXIT_OK; }

  for (const area of live) Object.assign(area, plan({ root: area.root, patch: area.patch, files: area.files }));
  try {
    for (const area of live) {
      for (const r of area.rows) log(`  ${r.state.padEnd(8)} ${r.status} ${area.name === 'software' ? '' : `${area.name}/`}${r.path}${r.why ? `  -- ${r.why}` : ''}${r.note ? `  (${r.note})` : ''}`);
    }
    const conflicts = live.flatMap((area) => area.rows.filter((r) => r.state === 'conflict').map(() => area.name));
    for (const area of live) area.todo = area.rows.filter((r) => r.state === 'applies');
    const todoCount = live.reduce((n, area) => n + area.todo.length, 0);
    if (conflicts.length) {
      log(`\nREFUSED: ${conflicts.length} file(s) here differ where the change was made. Nothing was written.`);
      log('  Those files were edited on this machine since alpha-full was taken. Apply those changes by hand, or ask a session to merge them.');
      if (conflicts.every((name) => name === 'scripts')) {
        log('  Every refusal is under scripts\\. To update software\\ now and leave the scripts as they are: add --skip-scripts.');
      }
      return EXIT_REFUSED;
    }
    if (!todoCount) {
      log('\nok: every change is already here');
      writeState(statePath, to, scriptsTo);
      return EXIT_OK;
    }
    if (!opts.apply) {
      log(`\nREADY: ${todoCount} file(s) would change, and all of them apply cleanly. Nothing was written.`);
      log('  Apply:  node scripts/apply-alpha-update.mjs --alpha-root <same folder> --apply --restart');
      return EXIT_OK;
    }

    // Apply in each scratch tree, then copy back with each file's own endings.
    for (const area of live.filter((x) => x.todo.length)) {
      const applied = git(['apply', '-v', ...area.todo.map((r) => `--include=${r.path}`), area.patchFile], { cwd: area.tree, allowFail: true });
      if (applied.status !== 0) { log(`STOP: git apply failed: ${applied.stderr.trim()}`); return EXIT_ERROR; }
      area.applyLog = applied.stderr ?? '';
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDir = join(ops, 'backups', `alpha-full-update-${stamp}`);
    const manifestAreas = live.map((area) => ({
      name: area.name,
      root: area.root,
      changed: area.todo.filter((r) => area.meta[r.path].existed).map((r) => r.path),
      added: area.todo.filter((r) => !area.meta[r.path].existed).map((r) => r.path),
    }));
    const frontendTouched = areas[0].todo?.some((r) => r.path.startsWith('frontend/')) ?? false;
    const scriptsTouched = live.some((area) => area.name === 'scripts' && area.todo.length);
    for (const area of manifestAreas) {
      for (const path of area.changed) {
        mkdirSync(dirname(join(backupDir, 'files', area.name, path)), { recursive: true });
        cpSync(join(area.root, path), join(backupDir, 'files', area.name, path));
      }
    }
    mkdirSync(backupDir, { recursive: true }); // an update that only adds files copies nothing into it
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify({ softwareRoot, from, to, frontendTouched, areas: manifestAreas }, null, 2));
    log(`\n  backup: ${backupDir}`);

    for (const area of live) {
      for (const r of area.todo) {
        const target = join(area.root, r.path);
        if (r.status === 'D') { rmSync(target, { force: true }); continue; }
        writeLive(target, readFileSync(join(area.tree, r.path), 'utf8'), area.meta[r.path]);
      }
    }
    log(`  ok: wrote ${todoCount} file(s)`);

    const undo = (why) => {
      log(`  ${why} -- putting everything back`);
      rollback(backupDir, log);
      return EXIT_ERROR;
    };

    const written = live.flatMap((area) => area.todo.filter((r) => r.status !== 'D').map((r) => join(area.root, r.path)));
    const pyFiles = written.filter((f) => f.endsWith('.py'));
    if (pyFiles.length) {
      const candidates = pythonCandidates(opts.python, softwareRoot);
      const usable = candidates.filter(([cmd, ...pre]) => spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8' }).status === 0);
      if (!usable.length) return undo('no Python found to check the backend files (pass --python)');
      for (const file of pyFiles) {
        const area = live.find((a) => file.startsWith(join(a.root, '')));
        const rel = area ? relative(area.root, file).split(sep).join('/') : null;
        // Judge a changed file with a Python that reads it as it was before
        // the merge; a new file with the first one that runs.
        const before = area && rel ? join(backupDir, 'files', area.name, ...rel.split('/')) : null;
        let python = usable[0];
        if (before && existsSync(before)) {
          python = usable.find((py) => pythonParses(py, before).ok);
          if (!python) { log(`  note: no Python here reads ${file} as it was before this update either; not checked`); continue; }
        }
        const res = pythonParses(python, file);
        if (res.ok) continue;
        const where = rel ? nearestHunk(area.patch, rel, res.line, area.applyLog) : null;
        // Kept for whoever fixes it on this machine; rollback puts the live copy back.
        const kept = join(backupDir, 'failed', area?.name ?? '', rel ?? basename(file));
        mkdirSync(dirname(kept), { recursive: true });
        cpSync(file, kept);
        log(`  the merged file is kept at ${kept}`);
        return undo(`${file} does not parse: ${res.detail}${where ? ` (${where})` : ''}`);
      }
      log(`  ok: ${pyFiles.length} Python file(s) parse`);
    }
    const psFiles = written.filter((f) => f.endsWith('.ps1'));
    if (psFiles.length) {
      const ps = findPowerShell();
      if (!ps) {
        log(`  note: no PowerShell found to check ${psFiles.length} .ps1 file(s); not checked`);
      } else {
        for (const file of psFiles) {
          const res = powerShellParses(ps, file);
          if (!res.ok) return undo(`${file} does not parse: ${res.detail}`);
        }
        log(`  ok: ${psFiles.length} PowerShell file(s) parse`);
      }
    }

    if (frontendTouched && !opts.skipBuild) {
      const fe = join(softwareRoot, 'frontend');
      const built = installAndBuild(fe, areas[0].todo.map((r) => r.path), log);
      if (!built.ok) {
        const code = undo(built.why);
        // Packages are whole again even if the build failed; whatever was
        // stopped to reinstall them must not stay down.
        if (built.stopped) startFrontend(log);
        return code;
      }
      log('  ok: frontend built');
      if (built.stopped && !opts.restart) startFrontend(log);
    }

    writeState(statePath, to, scriptsTo);
    log(`\nDONE. Undo with:  node scripts/apply-alpha-update.mjs --rollback "${backupDir}"${frontendTouched ? '' : ' --skip-build'} --restart`);
    if (opts.restart) restartWindows(log);
    else log('  The running Alpha has the old code until the backend and frontend restart (re-run with --restart).');
    if (scriptsTouched) {
      log('  The stewards load their scripts when they start: restart them too (close the agent windows, then open "Alpha Governed Agents").');
    }
    return EXIT_OK;
  } finally {
    for (const area of live) if (area.stage) rmSync(area.stage, { recursive: true, force: true });
  }
}

/** Where the commit last applied here from `branch` is recorded. live-sync.mjs reads the same file. */
export function appliedStatePath(ops, branch = DEFAULTS.branch) {
  return join(ops, branch === DEFAULTS.branch ? 'alpha-full-applied.json' : `applied-${branch.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

export function writeState(statePath, to, scriptsTo = null) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ to, scripts_to: scriptsTo, at: new Date().toISOString() }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code), (e) => { console.error(`STOP: ${e.message}`); process.exit(EXIT_ERROR); });
}
