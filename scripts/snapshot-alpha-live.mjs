#!/usr/bin/env node
/**
 * Puts the live Alpha's versions of the files `alpha-full` already tracks onto
 * a new branch of vyos88/Alpha, so a session can merge fixes onto the code
 * that actually runs instead of a month-old snapshot of it.
 *
 * Why not publish the whole folder: on Laptop41 it is 117,000 files and 55 GB
 * (model checkpoints, disk images, databases, test zips). What the merge needs
 * is narrower: for every file alpha-full tracks under software\ and scripts\,
 * the version this machine runs. Nothing new is added, so nothing that has
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
 * The branch is alpha-from-host-<date>-<time>, new each run, from alpha-full.
 * Never main, never alpha-full, never forced. Alpha is private; the push uses
 * this machine's git credentials.
 *
 * Other options: --repo <url>  --ops <dir>  --work <dir>
 *
 * Exit codes: 0 done (or report clean); 2 a finding stopped the push; 1 could not run.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

function git(args, { cwd, allowFail = false } = {}) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
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

/** Added lines that look like a credential, as file and line, never the value. */
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
      if (hit) findings.push({ file, line, label: hit.label });
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
  git(['checkout', '-q', '-B', 'snapshot', `origin/${UPDATE_DEFAULTS.branch}`], { cwd: work });
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
  if (!changed) { log('ok: the live files match alpha-full; nothing to publish'); return 0; }

  const stat = git(['diff', '--stat=120', '--stat-count=60'], { cwd: work }).stdout.trimEnd();
  log(stat.split('\n').map((l) => `  ${l}`).join('\n'));

  const findings = scanAddedLines(git(['diff', '-U0', '--no-color'], { cwd: work }).stdout);
  if (findings.length) {
    log('\nPOSSIBLE CREDENTIALS in lines this machine added (values not printed):');
    for (const f of findings) log(`  ${f.file.slice(BASE.length + 1)}:${f.line}  ${f.label}`);
    log('\nREFUSED: nothing was pushed. Look at each line. If one holds a real secret, move it to .env.local and rotate it; then run this again.');
    return 2;
  }
  log('  no credential-looking lines among the changes');

  if (!opts.push) {
    log(`\nREADY: ${changed} file(s) would go to a new branch of vyos88/Alpha. Nothing was pushed.`);
    log('  Push:  node scripts/snapshot-alpha-live.mjs --alpha-root <same folder> --push');
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const branch = opts.branch ?? `alpha-from-host-${stamp}`;
  git(['checkout', '-q', '-b', branch], { cwd: work });
  git(['add', '-A', '--', ...AREAS.map((a) => `${BASE}/${a}`)], { cwd: work });
  git(['-c', 'user.name=Alpha host', '-c', 'user.email=alpha-host@localhost', 'commit', '-q', '-m',
    `Live Alpha on this machine: ${changed} file(s) that differ from alpha-full\n\nsnapshot-alpha-live.mjs, from ${liveRoot}. Only files alpha-full tracks under software/ and scripts/; line endings and BOM matched to the repository.`], { cwd: work });
  const pushed = git(['push', 'origin', `${branch}:refs/heads/${branch}`], { cwd: work, allowFail: true });
  if (pushed.status !== 0) { log(`STOP: push failed: ${(pushed.stderr || pushed.stdout).trim()}`); return 1; }
  log(`\nDONE: pushed ${branch} (${changed} file(s)). Tell the session that branch name.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code), (e) => { console.error(`STOP: ${e.message}`); process.exit(1); });
}
