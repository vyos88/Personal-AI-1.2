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
 * Other options: --from <commit>  --to <branch|commit>  --repo <url>
 *   --ops <dir> (default C:\AlphaData\alpha-ops)  --python <exe>  --skip-build
 *
 * Exit codes: 0 done or nothing to do; 2 refused (a change does not apply),
 * nothing written; 1 could not run, or applied and then rolled back.
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULTS = {
  repo: 'https://github.com/vyos88/Alpha',
  branch: 'alpha-full',
  // alpha-full before the first change made from a cloud session for this
  // host (Alpha #36, 2026-10-04). Later runs start from the commit recorded in
  // <ops>/alpha-full-applied.json instead.
  from: '872a06a66c9428bc8d5c2a6ce7d6d1c8b8e39b00',
  subdir: 'BuildArtifacts/installers/Alpha-Full/software',
  ops: platform() === 'win32' ? 'C:\\AlphaData\\alpha-ops' : join(homedir(), 'alpha-ops'),
};

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_REFUSED = 2;

export function parseArgs(argv) {
  const opts = { apply: false, restart: false, skipBuild: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--apply') opts.apply = true;
    else if (a === '--restart') opts.restart = true;
    else if (a === '--skip-build') opts.skipBuild = true;
    else if (a === '--alpha-root') opts.alphaRoot = next();
    else if (a === '--from') opts.from = next();
    else if (a === '--to') opts.to = next();
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
  const patch = git(['diff', '--no-color', '--no-ext-diff', rel, from, to, '--', subdir], { cwd: cache }).stdout;
  const files = git(['diff', '--name-status', '--no-renames', rel, from, to, '--', subdir], { cwd: cache }).stdout
    .split('\n').filter(Boolean).map((line) => {
      const [status, path] = line.split('\t');
      return { status: status[0], path };
    });
  return { patch, files };
}

function readLive(file) {
  const raw = readFileSync(file);
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const text = raw.subarray(bom ? 3 : 0).toString('utf8');
  return { bom, crlf: text.includes('\r\n'), text: text.replace(/\r\n/g, '\n') };
}

function writeLive(file, text, { bom = false, crlf = false } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const body = Buffer.from(crlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  writeFileSync(file, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body);
}

/**
 * Copies the live files the patch touches into a scratch tree, LF-normalised,
 * and asks git file by file: does it apply, is it already applied, or neither.
 */
export function plan({ softwareRoot, patch, files }) {
  const stage = mkdtempSync(join(tmpdir(), 'alpha-update-'));
  const patchFile = join(stage, '.update.patch');
  writeFileSync(patchFile, patch);
  const tree = join(stage, 'tree');
  const meta = {};
  for (const f of files) {
    const live = join(softwareRoot, f.path);
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

function findPython(given) {
  if (given) return given;
  for (const name of platform() === 'win32' ? ['py', 'python'] : ['python3', 'python']) {
    const r = spawnSync(name, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return name;
  }
  return null;
}

function pythonParses(python, file) {
  const code = 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8-sig").read())';
  const r = spawnSync(python, ['-c', code, file], { encoding: 'utf8' });
  return { ok: r.status === 0, detail: (r.stderr || '').trim().split('\n').pop() };
}

function npm(args, cwd) {
  // npm on Windows is npm.cmd, which cannot be spawned without a shell. The
  // arguments here are fixed strings, never input.
  const win = platform() === 'win32';
  const r = spawnSync(win ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', shell: win, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, tail: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n') };
}

/** Puts every file in a backup back, and removes the ones the apply added. */
export function rollback(backupDir, log = console.log) {
  const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
  for (const path of manifest.changed) {
    cpSync(join(backupDir, 'files', path), join(manifest.softwareRoot, path));
  }
  for (const path of manifest.added) rmSync(join(manifest.softwareRoot, path), { force: true });
  log(`  restored ${manifest.changed.length} file(s), removed ${manifest.added.length} added file(s) under ${manifest.softwareRoot}`);
  return manifest;
}

function restartWindows(log) {
  if (platform() !== 'win32') { log('  --restart only does something on the Windows host; restart Alpha by hand.'); return; }
  for (const task of ['Alpha Backend', 'Alpha']) {
    const q = spawnSync('schtasks', ['/Query', '/TN', task], { encoding: 'utf8' });
    if (q.status !== 0) { log(`  no scheduled task '${task}': restart it by hand`); continue; }
    spawnSync('schtasks', ['/End', '/TN', task], { encoding: 'utf8' });
    const r = spawnSync('schtasks', ['/Run', '/TN', task], { encoding: 'utf8' });
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
      const ci = npm(['ci', '--no-audit', '--no-fund'], fe);
      const build = ci.ok ? npm(['run', 'build'], fe) : ci;
      log(build.ok ? '  ok: frontend rebuilt' : `  frontend rebuild failed:\n${build.tail}`);
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
  const statePath = join(ops, 'alpha-full-applied.json');
  const recorded = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  const cache = join(ops, 'alpha-full-cache.git');
  const branch = DEFAULTS.branch;
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

  const { patch, files } = buildPatch({ cache, from, to, subdir: DEFAULTS.subdir });
  if (!files.length) { log('ok: nothing new on alpha-full since the last apply'); return EXIT_OK; }

  const p = plan({ softwareRoot, patch, files });
  try {
    for (const r of p.rows) log(`  ${r.state.padEnd(8)} ${r.status} ${r.path}${r.why ? `  -- ${r.why}` : ''}`);
    const conflicts = p.rows.filter((r) => r.state === 'conflict');
    const todo = p.rows.filter((r) => r.state === 'applies');
    if (conflicts.length) {
      log(`\nREFUSED: ${conflicts.length} file(s) here differ where the change was made. Nothing was written.`);
      log('  Those files were edited on this machine since alpha-full was taken. Apply those changes by hand, or ask a session to merge them.');
      return EXIT_REFUSED;
    }
    if (!todo.length) {
      log('\nok: every change is already here');
      writeState(statePath, to);
      return EXIT_OK;
    }
    if (!opts.apply) {
      log(`\nREADY: ${todo.length} file(s) would change, and all of them apply cleanly. Nothing was written.`);
      log('  Apply:  node scripts/apply-alpha-update.mjs --alpha-root <same folder> --apply --restart');
      return EXIT_OK;
    }

    // Apply in the scratch tree, then copy back with each file's own endings.
    const applied = git(['apply', ...todo.map((r) => `--include=${r.path}`), p.patchFile], { cwd: p.tree, allowFail: true });
    if (applied.status !== 0) { log(`STOP: git apply failed: ${applied.stderr.trim()}`); return EXIT_ERROR; }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDir = join(ops, 'backups', `alpha-full-update-${stamp}`);
    const changed = todo.filter((r) => p.meta[r.path].existed).map((r) => r.path);
    const added = todo.filter((r) => !p.meta[r.path].existed).map((r) => r.path);
    const frontendTouched = todo.some((r) => r.path.startsWith('frontend/'));
    for (const path of changed) {
      mkdirSync(dirname(join(backupDir, 'files', path)), { recursive: true });
      cpSync(join(softwareRoot, path), join(backupDir, 'files', path));
    }
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify({ softwareRoot, from, to, changed, added, frontendTouched }, null, 2));
    log(`\n  backup: ${backupDir}`);

    for (const r of todo) {
      const target = join(softwareRoot, r.path);
      if (r.status === 'D') { rmSync(target, { force: true }); continue; }
      writeLive(target, readFileSync(join(p.tree, r.path), 'utf8'), p.meta[r.path]);
    }
    log(`  ok: wrote ${todo.length} file(s)`);

    const undo = (why) => {
      log(`  ${why} -- putting everything back`);
      rollback(backupDir, log);
      return EXIT_ERROR;
    };

    const pyFiles = todo.filter((r) => r.path.endsWith('.py') && r.status !== 'D');
    if (pyFiles.length) {
      const python = findPython(opts.python);
      if (!python) return undo('no Python found to check the backend files (pass --python)');
      for (const r of pyFiles) {
        const res = pythonParses(python, join(softwareRoot, r.path));
        if (!res.ok) return undo(`${r.path} does not parse: ${res.detail}`);
      }
      log(`  ok: ${pyFiles.length} Python file(s) parse`);
    }

    if (frontendTouched && !opts.skipBuild) {
      const fe = join(softwareRoot, 'frontend');
      log('  installing frontend packages (npm ci) and building...');
      const ci = npm(['ci', '--no-audit', '--no-fund'], fe);
      if (!ci.ok) return undo(`npm ci failed:\n${ci.tail}`);
      const build = npm(['run', 'build'], fe);
      if (!build.ok) return undo(`the frontend build failed:\n${build.tail}`);
      log('  ok: frontend built');
    }

    writeState(statePath, to);
    log(`\nDONE. Undo with:  node scripts/apply-alpha-update.mjs --rollback "${backupDir}"${frontendTouched ? '' : ' --skip-build'} --restart`);
    if (opts.restart) restartWindows(log);
    else log('  The running Alpha has the old code until the backend and frontend restart (re-run with --restart).');
    return EXIT_OK;
  } finally {
    rmSync(p.stage, { recursive: true, force: true });
  }
}

function writeState(statePath, to) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ to, at: new Date().toISOString() }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code), (e) => { console.error(`STOP: ${e.message}`); process.exit(EXIT_ERROR); });
}
