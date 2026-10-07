#!/usr/bin/env node
/**
 * Keeps this machine's Alpha and its live branch the same code, in both
 * directions, one pass at a time. The autopilot runs it every five minutes
 * (autofix.liveSync in actions.json); it can also be run by hand.
 *
 * Why: on 2026-10-06 the live Alpha on Worker1 imported 153 Python modules that
 * were in no branch at all, fixes merged in the cloud reached it only when a
 * session remembered to queue them, and a fix written against the branch
 * (Alpha#75) touched a file the machine never had. The branch and the machine
 * had drifted in both directions.
 *
 * Deliver. When the branch has a commit this machine has not applied, it is
 * applied with apply-alpha-update.mjs, under that script's rules: a change
 * that does not apply refuses the whole update, a file that no longer parses
 * or a frontend that no longer builds is put back on the spot, and the backend
 * and the site are restarted (only those two: the music and image bridges are
 * left alone). Each branch tip is tried once. A failure is reported and the
 * next commit on the branch is what gets tried, never the same one every five
 * minutes.
 *
 * Capture (--capture, on the one machine that runs Alpha live). When this
 * machine runs exactly the branch tip, the source files edited here, and the
 * source files only this machine has, are committed onto the branch and
 * pushed, fast-forward only. Only when in sync: otherwise this machine's older
 * copy of a file would be pushed over a commit it has not applied yet. Each
 * area is checked on its own record: scripts\ is captured only when the
 * scripts were applied up to the same tip. What counts as source is the
 * snapshot's rule (snapshot-alpha-live.mjs --include-new): source extensions,
 * no data, build, package, log or key folders, nothing over 512 KB, no file
 * named like a secret, and Alpha's .gitignore wins. Every captured line goes
 * through the snapshot's credential scan; a file with a finding is held back
 * and named by file and line, with every value cut to four characters, and
 * the rest go. Clearing a finding is the owner's alone: --allow takes the
 * list they approved (autofix.liveSync.allow), exact path:line entries, so a
 * line that moves or a new finding is held back again.
 *
 * Knowledge: Alpha learns from memory/knowledge/*.json, which its backend
 * reads once, at start (knowledge_autoload.py), and neither area above
 * carries that folder. So every pass also writes the branch's documents there:
 * one this machine lacks, or still holds exactly as it was delivered or found
 * equal, is written; one edited here is kept and named; nothing is deleted.
 * When one is written, Alpha Backend is restarted so Alpha reads it. Nothing
 * here is captured back.
 *
 * Never: a force push, a change to this checkout, a restart of anything but
 * what apply-alpha-update.mjs restarts.
 *
 *   node scripts/live-sync.mjs --alpha-root <dir> --branch <live branch> [--capture]
 *
 * Other options: --ops <dir>  --repo <url>  --machine <name>
 *   --capture-every-min <n> (default 60)  --skip-scripts  --no-restart
 *   --allow <path:line,...>  (the owner's approved list; see above)
 *   --python <exe> and --skip-build (passed on to apply-alpha-update.mjs)
 *
 * Its state is in the lines that start IN SYNC, DELIVERED, REFUSED, FAILED,
 * WAITING, CAPTURED, HELD BACK, SKIPPED, KNOWLEDGE or STOP; the autopilot reports only
 * when those change. Exit codes: 0 fine; 2 needs a person (refused, failed,
 * held back); 1 could not run.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULTS, RESTART_TASKS, appliedStatePath, fetchBranch, findSoftwareRoot, main as applyUpdate, resolveCommit,
  restartWindows, writeState,
} from './apply-alpha-update.mjs';
import {
  NEW_FILE_EXTENSIONS, NEW_FILE_MAX_COUNT, NEW_FILE_SKIP_DIRS, inRepoShape, isCapturableJson, newSourceFiles, scanAddedLines,
} from './snapshot-alpha-live.mjs';

const BASE = 'BuildArtifacts/installers/Alpha-Full';
const AREAS = ['software', 'scripts'];
// Tracked files that change with the code although they are not source.
const TRACKED_NAMES = new Set(['package.json', 'package-lock.json', 'requirements.txt', 'requirements-dev.txt']);
// What Alpha reads at start, and the names it may take there.
const KNOWLEDGE_DIR = `${BASE}/memory/knowledge`;
const KNOWLEDGE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,150}\.json$/;
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_PERSON = 2;

// One entry of the owner's list: a path inside Alpha's root and a line number.
const ALLOW_ID = /^[A-Za-z0-9_./-]+:\d+$/;

export function parseArgs(argv) {
  const opts = { capture: false, restart: true, skipScripts: false, skipBuild: false, captureEveryMin: 60 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--alpha-root') opts.alphaRoot = next();
    else if (a === '--branch') opts.branch = next();
    else if (a === '--ops') opts.ops = next();
    else if (a === '--repo') opts.repo = next();
    else if (a === '--work') opts.work = next();
    else if (a === '--machine') opts.machine = next();
    else if (a === '--python') opts.python = next();
    else if (a === '--capture') opts.capture = true;
    else if (a === '--allow') {
      opts.allow = next().split(',').map((x) => x.trim()).filter(Boolean);
      const bad = opts.allow.filter((x) => !ALLOW_ID.test(x));
      if (bad.length) throw new Error(`--allow entries must be path:line (${bad.length} are not)`);
    }
    else if (a === '--capture-every-min') {
      opts.captureEveryMin = Number(next());
      if (!Number.isFinite(opts.captureEveryMin) || opts.captureEveryMin < 0) throw new Error('--capture-every-min needs a number of minutes');
    } else if (a === '--skip-scripts') opts.skipScripts = true;
    else if (a === '--skip-build') opts.skipBuild = true;
    else if (a === '--no-restart') opts.restart = false;
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

function git(args, { cwd, allowFail = false, input } = {}) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`git not found: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r;
}

const short = (sha) => String(sha ?? '').slice(0, 7);

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function syncStatePath(ops, branch) {
  return join(ops, `live-sync-${branch.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

/** A tracked file capture may overlay: source, or a package or requirements file, outside data and build folders. */
export function capturableTracked(rel) {
  const parts = rel.split('/');
  if (parts.slice(0, -1).some((p) => NEW_FILE_SKIP_DIRS.has(p.toLowerCase()) || p.startsWith('.'))) return false;
  const name = parts.at(-1);
  if (TRACKED_NAMES.has(name)) return true;
  if (isCapturableJson(rel)) return true;
  const dot = name.lastIndexOf('.');
  return dot > 0 && NEW_FILE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

const blobSha = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const listNames = (names) => `${names.slice(0, 12).join(', ')}${names.length > 12 ? ', ...' : ''}`;

/**
 * The branch's knowledge documents (memory/knowledge/*.json at `tip`) onto
 * this machine. A document is written when this machine does not have it, or
 * still has exactly the version that was last written or found equal here
 * (state.knowledge); one edited here is kept as it is and named. A document
 * that is not a JSON object is not written: Alpha would skip it. Nothing is
 * deleted. Returns the names written.
 */
export function deliverKnowledge({ cache, tip, liveRoot, state, log }) {
  const listing = git(['ls-tree', '-z', tip, '--', `${KNOWLEDGE_DIR}/`], { cwd: cache, allowFail: true });
  if (listing.status !== 0) { log(`KNOWLEDGE: could not list ${KNOWLEDGE_DIR} at ${short(tip)}`); return []; }
  const entries = listing.stdout.split('\0').filter(Boolean).map((row) => {
    const [meta, path] = row.split('\t');
    const [, type, sha] = meta.split(' ');
    return { type, sha, name: path.slice(KNOWLEDGE_DIR.length + 1) };
  }).filter((e) => e.type === 'blob' && KNOWLEDGE_NAME.test(e.name));
  const dir = join(liveRoot, 'memory', 'knowledge');
  const seen = (state.knowledge ??= {});
  const written = [];
  const kept = [];
  const broken = [];
  const failed = [];
  for (const e of entries) {
    const path = join(dir, e.name);
    const live = existsSync(path) ? readFileSync(path) : null;
    const liveSha = live && blobSha(live);
    if (liveSha === e.sha) { seen[e.name] = e.sha; continue; }
    // The bytes as committed: a string round trip would change a BOM or a stray byte.
    const blob = spawnSync('git', ['cat-file', 'blob', e.sha], { cwd: cache, maxBuffer: 64 * 1024 * 1024 });
    if (blob.status !== 0) { failed.push(e.name); continue; }
    const text = blob.stdout;
    const lf = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');
    // Line ends alone are not an edit (git on Windows may have written them),
    // and not a reason to restart the backend either.
    if (live && lf(live) === lf(text)) { seen[e.name] = liveSha; continue; }
    if (live && liveSha !== seen[e.name]) { kept.push(e.name); continue; }
    let doc = null;
    try { doc = JSON.parse(lf(text).replace(/^\uFEFF/, '')); } catch { /* not JSON */ }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { broken.push(e.name); continue; }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${path}.live-sync-tmp`, text);
      renameSync(`${path}.live-sync-tmp`, path);
      seen[e.name] = e.sha;
      written.push(e.name);
    } catch (err) {
      rmSync(`${path}.live-sync-tmp`, { force: true });
      failed.push(`${e.name} (${err.code ?? err.message})`);
    }
  }
  if (written.length) log(`KNOWLEDGE: ${written.length} document(s) for Alpha written to memory\\knowledge: ${listNames(written)}`);
  if (kept.length) log(`KNOWLEDGE: ${kept.length} document(s) differ here from the branch and are kept as they are: ${listNames(kept)}`);
  if (broken.length) log(`KNOWLEDGE: ${broken.length} document(s) on the branch are not a JSON object and were not written: ${listNames(broken)}`);
  if (failed.length) log(`KNOWLEDGE: ${failed.length} document(s) could not be written: ${listNames(failed)}`);
  return written;
}

async function deliver({ opts, ops, branch, softwareRoot, log, state }) {
  const recordPath = appliedStatePath(ops, branch);
  const record = readJson(recordPath);
  if (!record?.to) {
    log(`STOP: no record of what this machine runs from ${branch} (${recordPath}).`);
    log(`  Apply it once by hand: node scripts/apply-alpha-update.mjs --alpha-root <dir> --branch ${branch} --from <the commit it matches> --apply`);
    return { code: EXIT_ERROR };
  }
  const cache = join(ops, 'alpha-full-cache.git');
  try {
    fetchBranch({ cache, repo: opts.repo ?? DEFAULTS.repo, branch });
  } catch (e) {
    log(`STOP: could not fetch ${branch}: ${e.message}`);
    return { code: EXIT_ERROR };
  }
  const tip = resolveCommit(cache, branch);
  if (!tip) { log(`STOP: ${branch} has no commit to follow`); return { code: EXIT_ERROR }; }
  // Before the code, so a delivery that restarts the backend also teaches it.
  const taught = deliverKnowledge({ cache, tip, liveRoot: dirname(softwareRoot), state, log });
  const teach = (restarted) => {
    if (!taught.length || restarted) return;
    if (!opts.restart) { log('    restart Alpha Backend so Alpha reads them (--no-restart)'); return; }
    restartWindows((line) => log(`    ${line.trim()}`), { tasks: RESTART_TASKS.filter((t) => t.task === 'Alpha Backend') });
  };
  if (record.to === tip) {
    log(`IN SYNC: this machine runs ${short(tip)} of ${branch}`);
    teach(false);
    return { code: EXIT_OK, tip, record };
  }
  if (state.deliver?.tip === tip && state.deliver.code !== 0) {
    const how = state.deliver.code === 2 ? 'refused' : 'failed';
    log(`WAITING: ${short(tip)} was tried here and ${how}; the next commit on ${branch} is tried when it comes`);
    teach(false);
    return { code: EXIT_PERSON, tip, record };
  }
  const args = ['--alpha-root', dirname(softwareRoot), '--branch', branch, '--ops', ops, '--apply'];
  if (opts.repo) args.push('--repo', opts.repo);
  if (opts.restart) args.push('--restart');
  if (opts.skipScripts) args.push('--skip-scripts');
  if (opts.skipBuild) args.push('--skip-build');
  if (opts.python) args.push('--python', opts.python);
  const lines = [];
  const code = await applyUpdate(args, (line) => lines.push(String(line)));
  // apply-alpha-update's own words, indented so none is mistaken for a state line.
  for (const line of lines) for (const part of line.split('\n')) if (part.trim()) log(`    ${part}`);
  state.deliver = { tip, code, at: new Date().toISOString() };
  const after = readJson(recordPath);
  if (code === 0) log(`DELIVERED: ${short(record.to)}..${short(tip)} of ${branch}`);
  else if (code === 2) log(`REFUSED: ${short(tip)}: a file here differs where the change was made, and nothing was written`);
  else log(`FAILED: ${short(tip)} could not be applied, and what was written was put back (above)`);
  teach(lines.some((line) => line.includes("restarted task 'Alpha Backend'")));
  return { code: code === 0 ? EXIT_OK : EXIT_PERSON, tip, record: after ?? record };
}

/** A clone of the branch with only software\ and scripts\ checked out, at origin's tip. */
function prepareWork({ work, repo, branch }) {
  if (!existsSync(join(work, '.git'))) {
    mkdirSync(dirname(work), { recursive: true });
    git(['clone', '--filter=blob:none', '--no-checkout', '--single-branch', '--branch', branch, repo, work]);
    git(['sparse-checkout', 'set', '--cone', ...AREAS.map((a) => `${BASE}/${a}`)], { cwd: work });
  } else {
    git(['fetch', '--filter=blob:none', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: work });
  }
  // The clone is this script's own scratch space; a run that stopped halfway
  // leaves this machine's files in it.
  git(['checkout', '-q', '-f', '-B', 'live-sync', `origin/${branch}`], { cwd: work });
  git(['reset', '-q', '--hard', `origin/${branch}`], { cwd: work });
  git(['clean', '-qfd'], { cwd: work });
  return git(['rev-parse', 'HEAD'], { cwd: work }).stdout.trim();
}

async function capture({ opts, ops, branch, tip, record, liveRoot, log, state }) {
  const every = opts.captureEveryMin * 60 * 1000;
  const last = state.capture?.at ? Date.parse(state.capture.at) : 0;
  // A new owner-approved list is acted on at once, not at the next hour.
  const allowKey = [...new Set(opts.allow ?? [])].sort().join(',');
  if (state.capture?.tip === tip && (state.capture.allowKey ?? '') === allowKey && Date.now() - last < every) {
    for (const line of state.capture.summary ?? []) log(line);
    return state.capture.code ?? EXIT_OK;
  }
  const areas = ['software'];
  if (opts.skipScripts) log('SKIPPED: scripts\\ is not captured (--skip-scripts)');
  else if (!existsSync(join(liveRoot, 'scripts'))) { /* no scripts folder here: nothing to capture there */ }
  else if (record.scripts_to !== tip) log(`SKIPPED: scripts\\ is not captured: its last update here was ${short(record.scripts_to) || 'never'}, not ${short(tip)}`);
  else areas.push('scripts');

  const work = resolve(opts.work ?? join(ops, 'live-sync-work'));
  let workTip;
  try {
    workTip = prepareWork({ work, repo: opts.repo ?? DEFAULTS.repo, branch });
  } catch (e) {
    log(`STOP: could not check out ${branch} to capture into: ${e.message}`);
    return EXIT_ERROR;
  }
  if (workTip !== tip) {
    log(`SKIPPED: ${branch} moved to ${short(workTip)} while this ran; the next pass delivers it first`);
    return EXIT_OK;
  }

  const prefixes = areas.map((a) => `${BASE}/${a}/`);
  const inAreas = (path) => prefixes.some((p) => path.startsWith(p));
  const tracked = git(['ls-files', '--', ...AREAS.map((a) => `${BASE}/${a}`)], { cwd: work }).stdout.split('\n').filter(Boolean);
  const changed = [];
  for (const path of tracked) {
    const rel = path.slice(BASE.length + 1);
    if (!inAreas(path) || !capturableTracked(rel)) continue;
    const live = join(liveRoot, ...rel.split('/'));
    if (!existsSync(live)) continue;
    const repoBytes = readFileSync(join(work, path));
    const next = inRepoShape(readFileSync(live), repoBytes);
    if (!next.equals(repoBytes)) { writeFileSync(join(work, path), next); changed.push(rel); }
  }

  const { found } = newSourceFiles(liveRoot, tracked);
  const candidates = found.filter((rel) => inAreas(`${BASE}/${rel}`));
  const ignored = new Set(git(['check-ignore', '--no-index', '--stdin'], {
    cwd: work, allowFail: true, input: candidates.map((rel) => `${BASE}/${rel}`).join('\n'),
  }).stdout.split('\n').filter(Boolean).map((p) => p.slice(BASE.length + 1)));
  const added = candidates.filter((rel) => !ignored.has(rel));
  if (added.length > NEW_FILE_MAX_COUNT) {
    log(`STOP: ${added.length} new source files is more than ${NEW_FILE_MAX_COUNT}; something other than source code is in these folders`);
    return EXIT_ERROR;
  }
  for (const rel of added) {
    const target = join(work, BASE, ...rel.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(liveRoot, ...rel.split('/'))));
  }
  // Intent to add, so the credential scan below reads every line of them. In
  // batches: the first capture on Worker1 is some 1700 files, and one git per
  // file is minutes on Windows.
  for (let i = 0; i < added.length; i += 200) {
    git(['add', '-N', '--', ...added.slice(i, i + 200).map((rel) => `${BASE}/${rel}`)], { cwd: work });
  }

  const summary = [];
  // capturedTip: the tip this summary stands for until the next capture is due;
  // null makes the next pass try again.
  const finish = (code, capturedTip) => {
    for (const line of summary) log(line);
    state.capture = { tip: capturedTip, at: new Date().toISOString(), summary, code, allowKey };
    return code;
  };
  if (!changed.length && !added.length) {
    summary.push(`CAPTURED: nothing; every source file here matches ${short(tip)}`);
    return finish(EXIT_OK, tip);
  }

  // Hold back every file with a credential-looking line; the rest go.
  const findings = scanAddedLines(git(['diff', '-U0', '--no-color'], { cwd: work }).stdout)
    .map((f) => ({ ...f, rel: f.file.slice(BASE.length + 1) }))
    .map((f) => ({ ...f, id: `${f.rel}:${f.line}` }));
  // The owner's approved list (autofix.liveSync.allow): exactly these lines, by
  // path and line. A line that moves, or any new one, is held back again.
  const allowed = new Set(opts.allow ?? []);
  const cleared = findings.filter((f) => allowed.has(f.id));
  const open = findings.filter((f) => !allowed.has(f.id));
  const held = [...new Set(open.map((f) => f.rel))];
  for (const rel of held) {
    const path = `${BASE}/${rel}`;
    if (added.includes(rel)) {
      git(['rm', '-q', '--cached', '--', path], { cwd: work, allowFail: true });
      rmSync(join(work, path), { force: true });
    } else {
      git(['checkout', '-q', '--', path], { cwd: work });
    }
  }
  const sent = { changed: changed.filter((r) => !held.includes(r)), added: added.filter((r) => !held.includes(r)) };
  if (held.length) {
    summary.push(`HELD BACK: ${held.length} file(s) with credential-looking lines, not pushed: ${held.slice(0, 12).join(', ')}${held.length > 12 ? ', ...' : ''}`);
    for (const f of open) summary.push(`    ${f.id}  ${f.label}  ${f.text}`);
    summary.push('    If a line holds a real secret, move it to .env.local and rotate it. If the owner clears every line above, put this list in autofix.liveSync.allow:');
    // One line, last, so it survives the report's tail and can be copied whole.
    // A path --allow cannot take (a space, a bracket) is named instead of listed.
    const listable = open.filter((f) => ALLOW_ID.test(f.id));
    summary.push(`ALLOW WITH: ${listable.map((f) => f.id).join(',')}`);
    if (listable.length < open.length) summary.push(`    ${open.length - listable.length} line(s) cannot go on the list (rename the file): ${[...new Set(open.filter((f) => !ALLOW_ID.test(f.id)).map((f) => f.rel))].join(', ')}`);
  }
  const clearedSent = cleared.filter((f) => !held.includes(f.rel));
  if (clearedSent.length) summary.push(`    ${clearedSent.length} credential-looking line(s) cleared by the owner's list go with this capture`);
  if (!sent.changed.length && !sent.added.length) return finish(held.length ? EXIT_PERSON : EXIT_OK, tip);

  const machine = opts.machine ?? hostname();
  git(['add', '-A', '--', ...areas.map((a) => `${BASE}/${a}`)], { cwd: work });
  git(['-c', 'user.name=Alpha host', '-c', 'user.email=alpha-host@localhost', 'commit', '-q', '-m',
    `Live edits from ${machine}: ${sent.changed.length} changed, ${sent.added.length} new source file(s)\n\n`
    + `live-sync.mjs captured what ${machine} runs on top of ${short(tip)}, which it had applied: ${areas.join(' and ')}, source files only, `
    + `line endings and BOM matched to the repository, every line credential-scanned${held.length ? `; ${held.length} file(s) held back` : ''}.`], { cwd: work });
  const pushed = git(['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: work, allowFail: true });
  if (pushed.status !== 0) {
    summary.unshift(`SKIPPED: the push was refused (${(pushed.stderr || pushed.stdout).trim().split('\n').pop()}); ${branch} probably moved, and the next pass delivers it first`);
    return finish(EXIT_OK, null);
  }
  const newTip = git(['rev-parse', 'HEAD'], { cwd: work }).stdout.trim();
  // This machine already runs what was just pushed: record it as applied.
  writeState(appliedStatePath(ops, branch), newTip, areas.includes('scripts') ? newTip : record.scripts_to ?? null);
  summary.unshift(`CAPTURED: ${sent.changed.length} changed and ${sent.added.length} new source file(s) from ${machine}, pushed as ${short(newTip)} on ${branch}`);
  return finish(held.length ? EXIT_PERSON : EXIT_OK, newTip);
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { log(`STOP: ${e.message}`); return EXIT_ERROR; }
  if (!opts.alphaRoot) { log('STOP: pass --alpha-root <folder that holds Alpha>'); return EXIT_ERROR; }
  if (!opts.branch || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(opts.branch) || opts.branch.includes('..')) {
    log('STOP: pass --branch <the live branch>, a plain branch name');
    return EXIT_ERROR;
  }
  if (opts.branch === DEFAULTS.branch) { log(`STOP: ${DEFAULTS.branch} is the installer's branch, not a live one`); return EXIT_ERROR; }
  const softwareRoot = findSoftwareRoot(opts.alphaRoot);
  if (!softwareRoot) { log(`STOP: no backend/main.py with frontend/package.json under ${opts.alphaRoot}`); return EXIT_ERROR; }
  const liveRoot = dirname(softwareRoot);
  const ops = resolve(opts.ops ?? DEFAULTS.ops);
  mkdirSync(ops, { recursive: true });
  const statePath = syncStatePath(ops, opts.branch);
  const state = readJson(statePath) ?? {};

  const delivered = await deliver({ opts, ops, branch: opts.branch, softwareRoot, log, state });
  const codes = [delivered.code];
  if (opts.capture && delivered.tip && delivered.record?.to === delivered.tip) {
    codes.push(await capture({ opts, ops, branch: opts.branch, tip: delivered.tip, record: delivered.record, liveRoot, log, state }));
  } else if (opts.capture && delivered.tip) {
    log(`SKIPPED: nothing is captured while this machine is not on ${short(delivered.tip)}`);
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  // Could not run beats needs a person beats fine.
  return codes.includes(EXIT_ERROR) ? EXIT_ERROR : Math.max(...codes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code), (e) => { console.error(`STOP: ${e.message}`); process.exit(EXIT_ERROR); });
}
