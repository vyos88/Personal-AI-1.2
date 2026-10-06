#!/usr/bin/env node
/**
 * Checks the connections Alpha's brain deck (the Neurological Architecture
 * deck) draws on this machine, and with --fix brings the fix in.
 *
 * On 2026-10-06 the live deck joined its regions in a ring and drew spokes
 * from a fixed point (50,47) where no region sits, under "Topology
 * synchronized", while the backend's /neurobrain/anatomy-map sends nine
 * regions and the eleven real links between them. Nothing noticed: the deck
 * looked fine. This reads what the machine actually has, three layers deep:
 *
 *   1. the backend's anatomy map (main.py): every link joins two regions it
 *      defines, no link repeats or loops on itself, no region is left alone;
 *   2. the deck's source (BrainNeuralModel.jsx): it draws the links the
 *      backend sends (topologyEdges) and checks them (topologyCheck), with no
 *      line from a fixed point;
 *   3. the built site (frontend/dist): what the browser is actually served.
 *      A fixed source behind an old build is still a broken deck.
 *
 *   node scripts/brain-topology-check.mjs --alpha-root <dir>
 *   node scripts/brain-topology-check.mjs --alpha-root <dir> --fix --branch <alpha branch>
 *
 * --fix runs apply-alpha-update.mjs --apply --restart --branch <branch> when
 * the deck's source is the old one (that tool keeps backups and puts
 * everything back if the build fails). It tries once per version of the
 * source: if a fix changes nothing it is not repeated every pass, only after
 * --retry-hours (default 6), or when the source changes. A stale build alone
 * is left to the doctor's repair (repair-alpha-host.ps1 rebuilds with
 * rollback), and said so.
 *
 * Prints OK:, NOTE: and PROBLEM: lines. Exit 0 all fine; 1 a problem is open;
 * 2 a problem was fixed in this run (and checked again).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ok = (text) => ({ level: 'ok', text });
const note = (text) => ({ level: 'note', text });
const problem = (text, fix = null) => ({ level: 'problem', text, fix });

/** Regions and links of the @app.get('/neurobrain/anatomy-map') route. */
export function parseAnatomy(py) {
  const at = py.indexOf("@app.get('/neurobrain/anatomy-map')");
  if (at < 0) return { found: false, regions: [], links: [] };
  // From the line after the route's own `async def ...:` to the next top-level statement.
  const header = py.slice(at).search(/\n(?:async )?def [^\n]*\n/);
  if (header < 0) return { found: false, regions: [], links: [] };
  const rest = py.slice(at + header + 1).replace(/^[^\n]*\n/, '');
  const end = rest.search(/\n(?:@|def |async def |class |[A-Za-z_])/);
  const body = end < 0 ? rest : rest.slice(0, end);
  const linksAt = body.search(/\n\s*links\s*=/);
  const regionsPart = linksAt < 0 ? body : body.slice(0, linksAt);
  const linksLine = linksAt < 0 ? '' : body.slice(linksAt).split('\n').slice(0, 2).join('\n');
  const regions = [...regionsPart.matchAll(/'id':\s*'([\w-]+)'/g)].map((m) => m[1]);
  const links = [...linksLine.matchAll(/\[\s*'([\w-]+)'\s*,\s*'([\w-]+)'\s*\]/g)].map((m) => [m[1], m[2]]);
  return { found: true, regions, links };
}

export function checkAnatomy(py) {
  const { found, regions, links } = parseAnatomy(py);
  if (!found) return [note("the backend has no /neurobrain/anatomy-map route: the deck shows its reference diagram")];
  const out = [];
  const ids = new Set(regions);
  if (ids.size !== regions.length) out.push(problem(`the anatomy map names a region twice (${regions.length} regions, ${ids.size} different)`));
  if (!links.length) {
    out.push(problem(`the anatomy map sends ${regions.length} regions and no links: the deck has no real connections to draw`));
    return out;
  }
  const seen = new Set();
  const bad = [];
  const touched = new Set();
  for (const [s, t] of links) {
    const key = [s, t].sort().join('|');
    if (!ids.has(s) || !ids.has(t)) bad.push(`${s} → ${t} names a region the map does not define`);
    else if (s === t) bad.push(`${s} links to itself`);
    else if (seen.has(key)) bad.push(`${s} → ${t} is sent twice`);
    else { seen.add(key); touched.add(s); touched.add(t); }
  }
  if (bad.length) out.push(problem(`the anatomy map has ${bad.length} broken link(s): ${bad.join('; ')}`));
  const alone = regions.filter((id) => !touched.has(id));
  if (alone.length) out.push(note(`region(s) with no link: ${alone.join(', ')}`));
  if (!bad.length) out.push(ok(`the backend's anatomy map: ${regions.length} regions, ${seen.size} links, every one joins two regions`));
  return out;
}

export function checkDeckSource(jsx) {
  const drawsSent = /topologyEdges\(\s*state\.anatomy\s*,\s*regions\s*\)/.test(jsx);
  const checks = /topologyCheck\(/.test(jsx);
  const fixedOrigin = /x1="50"\s+y1="47"/.test(jsx);
  const ring = /regions\.map\(\(region,\s*index\)\s*=>\s*\(\{\s*from:\s*region,\s*to:\s*regions\[\(index \+ 1\) % regions\.length\]/.test(jsx);
  if (drawsSent && checks && !fixedOrigin) return [ok("the deck's source draws the links the backend sends and checks them (Region links)")];
  const why = [];
  if (ring || !drawsSent) why.push('joins the regions in a ring instead of the links the backend sends');
  if (fixedOrigin) why.push('draws lines from a fixed point (50,47) where no region sits');
  if (drawsSent && !checks) why.push('does not check its links (no Region links row)');
  return [problem(`the deck's source ${why.join(', and ')}`, 'source')];
}

/** files: [{name, text}] of frontend/dist/assets/*.js */
export function checkBundle(files, sourceOk) {
  const deck = files.filter((f) => f.text.includes('alpha-brain-synapses'));
  if (!files.length) return [note('no built site (frontend/dist/assets) to check')];
  if (!deck.length) return [note('the built site has no brain deck in it')];
  const old = deck.some((f) => /x1:\s*["'`]50["'`],\s*y1:\s*["'`]47["'`]/.test(f.text));
  const fixed = deck.some((f) => f.text.includes('Region links'));
  if (fixed && !old) return [ok(`the site serves the fixed deck (${deck.map((f) => f.name).join(', ')})`)];
  if (sourceOk) return [problem('the site serves a build from before the fix: the frontend needs a rebuild (the doctor\'s repair-alpha-host does it, with rollback)', 'build')];
  return [problem('the site serves the old deck: lines from a fixed point, not the backend\'s links', 'source')];
}

export function shouldTry(state, signature, now = Date.now(), retryHours = 6) {
  const last = state?.lastTry;
  if (!last || last.signature !== signature) return true;
  return now - Date.parse(last.at) >= retryHours * 3600_000;
}

/** The folder holding backend/ and frontend/: the root itself, or software/ under it. */
export function findSoftware(root) {
  for (const dir of [root, join(root, 'software')]) {
    if (existsSync(join(dir, 'backend', 'main.py')) || existsSync(join(dir, 'frontend', 'package.json'))) return dir;
  }
  return null;
}

export function runChecks(software) {
  const results = [];
  const mainPy = join(software, 'backend', 'main.py');
  if (existsSync(mainPy)) results.push(...checkAnatomy(readFileSync(mainPy, 'utf8')));
  else results.push(note(`no backend main.py under ${software}`));
  const jsxPath = join(software, 'frontend', 'src', 'components', 'BrainNeuralModel.jsx');
  let jsx = '';
  if (existsSync(jsxPath)) {
    jsx = readFileSync(jsxPath, 'utf8');
    results.push(...checkDeckSource(jsx));
  } else results.push(note('no BrainNeuralModel.jsx: this Alpha has no brain deck'));
  const sourceOk = !results.some((r) => r.fix === 'source');
  const assets = join(software, 'frontend', 'dist', 'assets');
  const files = existsSync(assets)
    ? readdirSync(assets).filter((n) => n.endsWith('.js')).map((name) => ({ name, text: readFileSync(join(assets, name), 'utf8') }))
    : [];
  if (jsx) results.push(...checkBundle(files, sourceOk));
  return { results, signature: createHash('sha256').update(jsx).digest('hex').slice(0, 16) };
}

function parseArgs(argv) {
  const o = { fix: false, retryHours: 6 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--alpha-root') o.alphaRoot = next();
    else if (a === '--fix') o.fix = true;
    else if (a === '--branch') o.branch = next();
    else if (a === '--state') o.state = next();
    else if (a === '--retry-hours') o.retryHours = Number(next());
    else if (a === '--ops') o.ops = next();
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.alphaRoot) throw new Error('--alpha-root is required');
  if (o.branch && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(o.branch) || o.branch.includes('..'))) throw new Error('--branch must be a plain branch name');
  return o;
}

function print(results) {
  for (const r of results) console.log(`${r.level === 'ok' ? 'OK' : r.level === 'note' ? 'NOTE' : 'PROBLEM'}: ${r.text}`);
}

export function main(argv = process.argv.slice(2)) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.log(`PROBLEM: ${e.message}`); return 1; }
  const software = findSoftware(resolve(o.alphaRoot));
  if (!software) { console.log(`NOTE: no Alpha under ${o.alphaRoot}: nothing to check here`); return 0; }
  let { results, signature } = runChecks(software);
  print(results);
  const open = results.filter((r) => r.level === 'problem');
  if (!open.length) return 0;
  if (!o.fix) return 1;
  if (!open.some((r) => r.fix === 'source')) {
    console.log('NOTE: nothing here for --fix: a rebuild is the doctor\'s repair, an anatomy map fix is a backend change');
    return 1;
  }
  if (!o.branch) { console.log('NOTE: --fix needs --branch (the Alpha branch that carries the fixed deck)'); return 1; }
  const statePath = o.state || join(o.ops || (process.platform === 'win32' ? 'C:\\AlphaData\\alpha-ops' : join(process.env.HOME || '.', 'alpha-ops')), 'brain-topology.json');
  let state = null;
  try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* first run */ }
  if (!shouldTry(state, signature, Date.now(), o.retryHours)) {
    console.log(`NOTE: the fix was already tried on this source at ${state.lastTry.at} (${state.lastTry.result}); not again before ${o.retryHours} h or a change`);
    return 1;
  }
  console.log(`FIX: bringing in ${o.branch} (apply-alpha-update.mjs --apply --restart)`);
  const update = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'apply-alpha-update.mjs'),
    '--alpha-root', o.alphaRoot, '--apply', '--restart', '--branch', o.branch], { encoding: 'utf8', timeout: 45 * 60_000 });
  const tail = `${update.stdout || ''}${update.stderr || ''}`.split(/\r?\n/).filter((l) => l.trim()).slice(-12);
  for (const l of tail) console.log(`  ${l}`);
  ({ results } = runChecks(software));
  const still = results.filter((r) => r.level === 'problem');
  console.log(still.length ? 'AFTER FIX: still open' : 'AFTER FIX: the deck is fixed');
  print(results);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ lastTry: { signature, at: new Date().toISOString(), branch: o.branch, exit: update.status, result: still.length ? 'still open' : 'fixed' } }, null, 1));
  return still.length ? 1 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main();
