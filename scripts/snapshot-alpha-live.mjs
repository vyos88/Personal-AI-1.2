#!/usr/bin/env node
/**
 * Puts the live Alpha's versions of the files `alpha-full` already tracks onto
 * a new branch of vyos88/Alpha, so a session can merge fixes onto the code
 * that actually runs instead of a month-old snapshot of it.
 *
 * Why not publish the whole folder: on Laptop41 it is 117,000 files and 55 GB
 * (model checkpoints, disk images, databases, test zips). What the merge needs
 * is narrower: for every file alpha-full tracks under software\ and scripts\,
 * the version this machine runs. Without --include-new nothing new is added, so nothing that has
 * never been reviewed (a database, a saved credential) can come along.
 *
 * Line endings and a UTF-8 BOM are matched to the repository's copy, so the
 * branch differs from alpha-full only where the content does. Every added line
 * is checked for anything that looks like a credential; a finding stops the
 * push, by file and line, never by value.
 *
 *   node scripts/snapshot-alpha-live.mjs --alpha-root <dir>          report: pushes nothing
 *   node scripts/snapshot-alpha-live.mjs --alpha-root <dir> --push   commit and push the branch
 *
 * A finding is printed with its line, every long value cut to its first four
 * characters and its length ("'alph…(28)'"), so it can be pasted to a reviewer
 * without leaking it. Once a reviewer has cleared exactly those lines:
 *   ... --push --allow software/frontend/src/tabs/Hubs.jsx:111,software/...
 * Any finding not on that list still stops the push.
 *
 * The branch is alpha-from-host-<date>-<time>, new each run, from alpha-full.
 * Never main, never alpha-full, never forced. Alpha is private; the push uses
 * this machine's git credentials.
 *
 * --include-new also brings source files this machine has and alpha-full never
 * had, because without them a fix to the live code cannot even be written
 * (2026-10-06: the fleet view imports fleet_unified_view.py, which exists only
 * on Laptop41). Only source code is taken: these folders, these extensions,
 * nothing over 512 KB, no folder that holds data, builds, packages or keys,
 * and no file named like a secret. Every line of every new file goes through
 * the same credential scan, so a finding stops the push just the same.
 *
 * Other options: --repo <url>  --ops <dir>  --work <dir>
 *
 * Exit codes: 0 done (or report clean); 2 a finding stopped the push; 1 could not run.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULTS as UPDATE_DEFAULTS, findSoftwareRoot } from './apply-alpha-update.mjs';
import { SECRET_CONTENT } from './publish-alpha.mjs';

const BASE = 'BuildArtifacts/installers/Alpha-Full';
const AREAS = ['software', 'scripts'];

export function parseArgs(argv) {
  const opts = { push: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--push') opts.push = true;
    else if (a === '--alpha-root') opts.alphaRoot = next();
    else if (a === '--repo') opts.repo = next();
    else if (a === '--ops') opts.ops = next();
    else if (a === '--work') opts.work = next();
    else if (a === '--branch') opts.branch = next();
    else if (a === '--include-new') opts.includeNew = true;
    else if (a === '--allow') opts.allow = next().split(',').map((x) => x.trim()).filter(Boolean);
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

// What --include-new may bring: source code in the folders a fix touches.
export const NEW_FILE_ROOTS = ['software/backend', 'software/frontend/src', 'software/frontend/scripts', 'software/windows-worker', 'software/android-worker', 'scripts'];
// The frontend imports data as JSON (the encyclopedia, every animal and plant
// model): on 2026-10-07 the live branch lacked 24 such files, so git could not
// build the site Worker1 serves. JSON is taken from these folders only, never
// from the backend, where JSON is runtime state that would change every pass.
export const NEW_JSON_ROOTS = ['software/frontend/src', 'software/frontend/public'];
export const NEW_JSON_MAX_BYTES = 2 * 1024 * 1024;
export const NEW_FILE_EXTENSIONS = new Set(['.py', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.ps1', '.html']);
export const NEW_FILE_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '__pycache__', '.venv', 'venv', 'env', '.git', 'memory', 'data',
  'logs', 'log', 'backups', 'backup', '.pytest_cache', 'coverage', '.tls', 'uploads', 'output', 'outputs', 'models', 'checkpoints', 'tmp', 'temp', 'cache']);
// `token(?!s)`: a design-tokens stylesheet (styles-tile-tokens.css, imported by
// main.jsx) is not a credential, and leaving it behind broke the build.
const NEW_FILE_SKIP_NAME = /(^\.env)|secret|credential|password|token(?!s)|private|\.key$|\.pem$|\.bak$|\.orig$/i;
export const NEW_FILE_MAX_BYTES = 512 * 1024;
// Laptop41 had 1745 new source files on 2026-10-06 (scripts\ alone holds
// hundreds of agent policies); the credential scan still reads every line.
export const NEW_FILE_MAX_COUNT = 3000;

/** Source files under `liveRoot` that --include-new may take, as repo-relative paths (software/..., scripts/...). */
export function newSourceFiles(liveRoot, tracked) {
  const known = new Set(tracked.map((p) => p.slice(BASE.length + 1)));
  const found = new Set();
  const skipped = [];
  const walk = (dir, accepts) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!NEW_FILE_SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')) walk(full, accepts);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = relative(liveRoot, full).split(sep).join('/');
      if (known.has(rel) || found.has(rel)) continue;
      const dot = e.name.lastIndexOf('.');
      const ext = dot < 0 ? '' : e.name.slice(dot).toLowerCase();
      if (!accepts(ext)) continue;
      if (NEW_FILE_SKIP_NAME.test(e.name)) { skipped.push(`${rel} (named like a secret)`); continue; }
      const json = ext === '.json';
      if (statSync(full).size > (json ? NEW_JSON_MAX_BYTES : NEW_FILE_MAX_BYTES)) { skipped.push(`${rel} (over ${json ? '2 MB' : '512 KB'})`); continue; }
      found.add(rel);
    }
  };
  for (const root of NEW_FILE_ROOTS) walk(join(liveRoot, ...root.split('/')), (ext) => NEW_FILE_EXTENSIONS.has(ext));
  for (const root of NEW_JSON_ROOTS) walk(join(liveRoot, ...root.split('/')), (ext) => ext === '.json');
  return { found: [...found].sort(), skipped };
}

/** Whether a repo-relative path (software/..., scripts/...) is data JSON capture may take. */
export function isCapturableJson(rel) {
  return rel.toLowerCase().endsWith('.json') && NEW_JSON_ROOTS.some((root) => rel.startsWith(`${root}/`));
}

function git(args, { cwd, allowFail = false, input } = {}) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`git not found: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r;
}

function shape(buffer) {
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const body = buffer.subarray(bom ? 3 : 0);
  return { bom, crlf: body.includes('\r\n'), body };
}

/** True for a file that is not text: compare and copy its bytes as they are. */
function binary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/**
 * The live file's content in the repository's shape: same BOM, same line
 * endings. Binary files are taken as they are.
 */
export function inRepoShape(liveBytes, repoBytes) {
  if (binary(liveBytes) || binary(repoBytes)) return liveBytes;
  const repo = shape(repoBytes);
  const live = shape(liveBytes);
  let text = live.body.toString('utf8').replace(/\r\n/g, '\n');
  if (repo.crlf) text = text.replace(/\n/g, '\r\n');
  const out = Buffer.from(text, 'utf8');
  return repo.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), out]) : out;
}

/**
 * The line with every value long enough to be a secret cut to its first four
 * characters and its length. Short words, names and syntax stay readable, so a
 * reviewer can tell a storage-key name from a real key.
 */
export function maskLine(text) {
  const cut = (v) => `${v.slice(0, 4)}…(${v.length})`;
  return text
    .replace(/(['"`])([^'"`]{8,})\1/g, (_m, q, v) => `${q}${cut(v)}${q}`)
    // Unquoted: only runs with a digit in them, so identifiers stay readable.
    .replace(/(^|[^A-Za-z0-9_…(])([A-Za-z0-9_\-.+/]{16,})/g, (m, pre, v) => (/\d/.test(v) ? `${pre}${cut(v)}` : m))
    .trim()
    .slice(0, 160);
}

/** Added lines that look like a credential: file, line and the masked line. */
export function scanAddedLines(diff) {
  const findings = [];
  let file = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) { file = raw.slice(6); continue; }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (raw.startsWith('+')) {
      const hit = SECRET_CONTENT.find(({ re }) => re.test(raw.slice(1)));
      if (hit) findings.push({ file, line, label: hit.label, text: maskLine(raw.slice(1)) });
      line++;
    } else if (!raw.startsWith('-') && !raw.startsWith('\\')) {
      line++;
    }
  }
  return findings;
}

/** A sparse checkout of alpha-full's software\ and scripts\, at the branch tip. */
function prepareWork({ work, repo }) {
  if (!existsSync(join(work, '.git'))) {
    mkdirSync(dirname(work), { recursive: true });
    git(['clone', '--filter=blob:none', '--no-checkout', '--single-branch', '--branch', UPDATE_DEFAULTS.branch, repo, work]);
    git(['sparse-checkout', 'set', '--cone', ...AREAS.map((a) => `${BASE}/${a}`)], { cwd: work });
  } else {
    git(['fetch', '--filter=blob:none', 'origin', `+refs/heads/${UPDATE_DEFAULTS.branch}:refs/remotes/origin/${UPDATE_DEFAULTS.branch}`], { cwd: work });
  }
  // -f: this clone is the script's own scratch space, and a run that stopped
  // halfway (a refused push) leaves the live files copied into it. Without
  // -f the next run cannot even switch branches.
  git(['checkout', '-q', '-f', '-B', 'snapshot', `origin/${UPDATE_DEFAULTS.branch}`], { cwd: work });
  git(['reset', '-q', '--hard', `origin/${UPDATE_DEFAULTS.branch}`], { cwd: work });
  git(['clean', '-qfd'], { cwd: work });
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { log(`STOP: ${e.message}`); return 1; }
  if (!opts.alphaRoot) { log('STOP: pass --alpha-root <folder that holds Alpha>'); return 1; }
  const softwareRoot = findSoftwareRoot(opts.alphaRoot);
  if (!softwareRoot) { log(`STOP: no backend/main.py with frontend/package.json under ${opts.alphaRoot}`); return 1; }
  const liveRoot = dirname(softwareRoot);
  log(`Alpha: ${liveRoot}`);

  const ops = resolve(opts.ops ?? UPDATE_DEFAULTS.ops);
  const work = resolve(opts.work ?? join(ops, 'alpha-snapshot'));
  try {
    prepareWork({ work, repo: opts.repo ?? UPDATE_DEFAULTS.repo });
  } catch (e) {
    log(`STOP: could not fetch ${UPDATE_DEFAULTS.branch}: ${e.message}`);
    log('  Alpha is a private repository: this machine needs git credentials for github.com.');
    return 1;
  }

  const tracked = git(['ls-files', '--', ...AREAS.map((a) => `${BASE}/${a}`)], { cwd: work }).stdout.split('\n').filter(Boolean);
  let changed = 0;
  const missing = [];
  for (const path of tracked) {
    const live = join(liveRoot, path.slice(BASE.length + 1));
    if (!existsSync(live)) { missing.push(path.slice(BASE.length + 1)); continue; }
    const repoBytes = readFileSync(join(work, path));
    const next = inRepoShape(readFileSync(live), repoBytes);
    if (!next.equals(repoBytes)) { writeFileSync(join(work, path), next); changed++; }
  }
  log(`  ${tracked.length} file(s) tracked under software\\ and scripts\\; ${changed} differ here; ${missing.length} not on this machine (left as they are)`);
  let added = 0;
  if (opts.includeNew) {
    const { found: candidates, skipped } = newSourceFiles(liveRoot, tracked);
    // Alpha's own .gitignore wins: `git add -N` refuses an ignored path and
    // stopped the whole snapshot (Laptop41, job 36: a game's builds folder).
    const ignored = new Set(git(['check-ignore', '--no-index', '--stdin'], {
      cwd: work, allowFail: true, input: candidates.map((rel) => `${BASE}/${rel}`).join('\n'),
    }).stdout.split('\n').filter(Boolean).map((p) => p.slice(BASE.length + 1)));
    const found = candidates.filter((rel) => !ignored.has(rel));
    if (ignored.size) skipped.unshift(`${ignored.size} file(s) Alpha's .gitignore ignores`);
    for (const s of skipped.slice(0, 20)) log(`  not taken: ${s}`);
    if (found.length > NEW_FILE_MAX_COUNT) {
      log(`STOP: ${found.length} new source files is more than ${NEW_FILE_MAX_COUNT}; something other than source code is in these folders. First ones: ${found.slice(0, 10).join(', ')}`);
      return 1;
    }
    for (const rel of found) {
      const target = join(work, BASE, ...rel.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(liveRoot, ...rel.split('/'))));
      // Intent to add: the diff below, and so the credential scan, then
      // includes every line of the new file.
      git(['add', '-N', '--', `${BASE}/${rel}`], { cwd: work });
      added++;
    }
    log(`  ${added} source file(s) only this machine has, taken with --include-new`);
  }
  if (!changed && !added) { log('ok: the live files match alpha-full; nothing to publish'); return 0; }

  const stat = git(['diff', '--stat=120', '--stat-count=60'], { cwd: work }).stdout.trimEnd();
  log(stat.split('\n').map((l) => `  ${l}`).join('\n'));

  const findings = scanAddedLines(git(['diff', '-U0', '--no-color'], { cwd: work }).stdout)
    .map((f) => ({ ...f, id: `${f.file.slice(BASE.length + 1)}:${f.line}` }));
  const allowed = new Set(opts.allow ?? []);
  const open = findings.filter((f) => !allowed.has(f.id));
  if (open.length) {
    log('\nPOSSIBLE CREDENTIALS in lines this machine added (long values cut to 4 characters):');
    for (const f of open) log(`  ${f.id}  ${f.label}\n      ${f.text}`);
    log('\nREFUSED: nothing was pushed. If a line holds a real secret, move it to .env.local and rotate it.');
    log('  If a reviewer has cleared every line above, add:  --allow ' + open.map((f) => f.id).join(','));
    return 2;
  }
  log(findings.length
    ? `  ${findings.length} credential-looking line(s), every one cleared with --allow`
    : '  no credential-looking lines among the changes');

  if (!opts.push) {
    log(`\nREADY: ${changed} file(s)${added ? ` and ${added} new file(s)` : ''} would go to a new branch of vyos88/Alpha. Nothing was pushed.`);
    log('  Push:  node scripts/snapshot-alpha-live.mjs --alpha-root <same folder> --push');
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const branch = opts.branch ?? `alpha-from-host-${stamp}`;
  git(['checkout', '-q', '-b', branch], { cwd: work });
  git(['add', '-A', '--', ...AREAS.map((a) => `${BASE}/${a}`)], { cwd: work });
  git(['-c', 'user.name=Alpha host', '-c', 'user.email=alpha-host@localhost', 'commit', '-q', '-m',
    `Live Alpha on this machine: ${changed} file(s) that differ from alpha-full${added ? `, ${added} source file(s) only it has` : ''}\n\nsnapshot-alpha-live.mjs, from ${liveRoot}. ${added ? 'Files alpha-full tracks under software/ and scripts/, plus new source files (--include-new: source folders and extensions only, each under 512 KB, credential-scanned)' : 'Only files alpha-full tracks under software/ and scripts/'}; line endings and BOM matched to the repository.`], { cwd: work });
  const pushed = git(['push', 'origin', `${branch}:refs/heads/${branch}`], { cwd: work, allowFail: true });
  if (pushed.status !== 0) { log(`STOP: push failed: ${(pushed.stderr || pushed.stdout).trim()}`); return 1; }
  log(`\nDONE: pushed ${branch} (${changed} file(s)${added ? `, ${added} new` : ''}). Tell the session that branch name.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code), (e) => { console.error(`STOP: ${e.message}`); process.exit(1); });
}
