import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkAnatomy, checkBundle, checkDeckSource, findSoftware, parseAnatomy, shouldTry,
} from '../scripts/brain-topology-check.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'brain-topology-check.mjs');

// The shape of Alpha's route (no Alpha code is kept in this repository).
function anatomy(regions, links) {
  return [
    "@app.get('/neurobrain/other')", 'async def other(): return {}', '',
    "@app.get('/neurobrain/anatomy-map')",
    'async def neurobrain_anatomy_map(current_user: dict = Depends(get_current_user)):',
    '    regions = [',
    ...regions.map((id, i) => `        {'id': '${id}', 'label': '${id}', 'x': ${10 + i}, 'y': ${20 + i}},`),
    '    ]',
    `    links = [${links.map(([s, t]) => `['${s}', '${t}']`).join(', ')}]`,
    "    return {'regions': regions, 'links': [{'source': s, 'target': t} for s, t in links]}",
    '', '', 'def _next(): pass', '',
  ].join('\n');
}
const REGIONS = ['prefrontal', 'sensory', 'language', 'hippocampus', 'thalamus', 'pineal', 'amygdala', 'cerebellum', 'observer'];
const LINKS = [['sensory', 'thalamus'], ['language', 'thalamus'], ['thalamus', 'prefrontal'], ['thalamus', 'hippocampus'], ['pineal', 'thalamus'],
  ['hippocampus', 'prefrontal'], ['amygdala', 'prefrontal'], ['cerebellum', 'sensory'], ['cerebellum', 'prefrontal'], ['observer', 'thalamus'], ['observer', 'prefrontal']];

const OLD_JSX = `
  const edges = useMemo(()=>regions.map((region,index)=>({
    from: region,
    to: regions[(index + 1) % regions.length],
  })),[regions])
  <svg className="alpha-brain-synapses">
    {edges.map(({from,to})=><line key={from.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />)}
    {regions.slice(2).map((to,index)=><line key={to.id} x1="50" y1="47" x2={to.x} y2={to.y} className="is-core-link" />)}
  </svg>`;
const NEW_JSX = `
  const edges = useMemo(()=>topologyEdges(state.anatomy, regions),[state.anatomy, regions])
  const linkCheck = useMemo(()=>topologyCheck(state.anatomy, regions),[state.anatomy, regions])
  <svg className="alpha-brain-synapses">{edges.map(({from,to,core})=><line x1={from.x} y1={from.y} />)}</svg>`;
const OLD_BUNDLE = 'x.className="alpha-brain-synapses";r.slice(2).map((e,s)=>a("line",{x1:"50",y1:"47",x2:e.x,y2:e.y}))';
const NEW_BUNDLE = 'x.className="alpha-brain-synapses";a("dt",{children:"Region links"})';

const levels = (rs) => rs.map((r) => r.level);

test('the real map: nine regions, eleven links, all joining two regions', () => {
  const parsed = parseAnatomy(anatomy(REGIONS, LINKS));
  assert.deepEqual([parsed.regions.length, parsed.links.length], [9, 11]);
  const rs = checkAnatomy(anatomy(REGIONS, LINKS));
  assert.deepEqual(levels(rs), ['ok']);
  assert.match(rs[0].text, /9 regions, 11 links/);
});

test('broken links in the map are named', () => {
  const rs = checkAnatomy(anatomy(['a', 'b', 'c'], [['a', 'b'], ['b', 'a'], ['a', 'a'], ['a', 'ghost']]));
  const p = rs.find((r) => r.level === 'problem');
  assert.match(p.text, /3 broken link/);
  assert.match(p.text, /b → a is sent twice; a links to itself; a → ghost names a region/);
  assert.ok(rs.some((r) => r.level === 'note' && /no link: c/.test(r.text)));
  assert.equal(checkAnatomy(anatomy(['a', 'b'], [])).at(-1).level, 'problem');
  assert.equal(checkAnatomy('no route here')[0].level, 'note');
});

test('the old deck source is caught, the fixed one passes', () => {
  const old = checkDeckSource(OLD_JSX);
  assert.equal(old[0].level, 'problem');
  assert.equal(old[0].fix, 'source');
  assert.match(old[0].text, /ring.*and.*fixed point \(50,47\)/);
  assert.deepEqual(levels(checkDeckSource(NEW_JSX)), ['ok']);
  const unchecked = checkDeckSource(NEW_JSX.replace(/topologyCheck/g, 'nothing'));
  assert.match(unchecked[0].text, /does not check its links/);
});

test('the built site is checked: old, fixed, and a stale build behind a fixed source', () => {
  assert.equal(checkBundle([{ name: 'a.js', text: OLD_BUNDLE }], false)[0].fix, 'source');
  const stale = checkBundle([{ name: 'a.js', text: OLD_BUNDLE }], true)[0];
  assert.equal(stale.fix, 'build');
  assert.match(stale.text, /needs a rebuild/);
  assert.deepEqual(levels(checkBundle([{ name: 'b.js', text: NEW_BUNDLE }, { name: 'c.js', text: 'other' }], true)), ['ok']);
  assert.equal(checkBundle([{ name: 'c.js', text: 'other' }], true)[0].level, 'note');
  assert.equal(checkBundle([], true)[0].level, 'note');
});

test('a fix is tried once per source, again only after the retry window', () => {
  const at = '2026-10-06T18:00:00.000Z';
  const now = Date.parse(at);
  assert.equal(shouldTry(null, 'aaa', now), true);
  assert.equal(shouldTry({ lastTry: { signature: 'aaa', at } }, 'aaa', now + 3600_000), false);
  assert.equal(shouldTry({ lastTry: { signature: 'aaa', at } }, 'aaa', now + 7 * 3600_000), true);
  assert.equal(shouldTry({ lastTry: { signature: 'aaa', at } }, 'bbb', now + 60_000), true);
});

function fakeAlpha({ jsx = OLD_JSX, bundle = OLD_BUNDLE } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'brain-'));
  const sw = join(root, 'software');
  mkdirSync(join(sw, 'backend'), { recursive: true });
  mkdirSync(join(sw, 'frontend', 'src', 'components'), { recursive: true });
  mkdirSync(join(sw, 'frontend', 'dist', 'assets'), { recursive: true });
  writeFileSync(join(sw, 'backend', 'main.py'), anatomy(REGIONS, LINKS));
  writeFileSync(join(sw, 'frontend', 'package.json'), '{}');
  writeFileSync(join(sw, 'frontend', 'src', 'components', 'BrainNeuralModel.jsx'), jsx);
  writeFileSync(join(sw, 'frontend', 'dist', 'assets', 'index-1.js'), bundle);
  return { root, sw };
}

// A scripts folder with this checker and a stand-in apply-alpha-update.mjs
// that "brings in" the fixed deck, as the real one would.
function scriptsWithFakeUpdate(works = true) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-scripts-'));
  copyFileSync(SCRIPT, join(dir, 'brain-topology-check.mjs'));
  writeFileSync(join(dir, 'apply-alpha-update.mjs'), `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const a = process.argv.slice(2);
const root = a[a.indexOf('--alpha-root') + 1];
console.log('args: ' + a.join(' '));
if (${works}) {
  writeFileSync(join(root, 'software', 'frontend', 'src', 'components', 'BrainNeuralModel.jsx'), ${JSON.stringify(NEW_JSX)});
  writeFileSync(join(root, 'software', 'frontend', 'dist', 'assets', 'index-1.js'), ${JSON.stringify(NEW_BUNDLE)});
}
console.log('DONE');
`);
  return join(dir, 'brain-topology-check.mjs');
}

const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('a fixed Alpha passes with exit 0; the old one is a problem with exit 1', () => {
  assert.equal(findSoftware('/nonexistent'), null);
  const good = fakeAlpha({ jsx: NEW_JSX, bundle: NEW_BUNDLE });
  const r = run(SCRIPT, ['--alpha-root', good.root]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal((r.stdout.match(/^OK:/gm) || []).length, 3);
  const bad = fakeAlpha();
  const b = run(SCRIPT, ['--alpha-root', bad.root]);
  assert.equal(b.status, 1);
  assert.match(b.stdout, /PROBLEM: the deck's source joins the regions in a ring/);
  const none = run(SCRIPT, ['--alpha-root', join(bad.root, 'nothing')]);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /no Alpha under/);
});

test('--fix brings the branch in, checks again, and does not repeat a fix that changed nothing', () => {
  const { root } = fakeAlpha();
  const state = join(root, 'state.json');
  const fixed = run(scriptsWithFakeUpdate(true), ['--alpha-root', root, '--fix', '--branch', 'claude/x-route-b', '--state', state]);
  assert.equal(fixed.status, 2, fixed.stdout);
  assert.match(fixed.stdout, /args: --alpha-root .* --apply --restart --branch claude\/x-route-b/);
  assert.match(fixed.stdout, /AFTER FIX: the deck is fixed/);
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).lastTry.result, 'fixed');

  const stuck = fakeAlpha();
  const s2 = join(stuck.root, 'state.json');
  const script = scriptsWithFakeUpdate(false);
  const first = run(script, ['--alpha-root', stuck.root, '--fix', '--branch', 'b', '--state', s2]);
  assert.equal(first.status, 1);
  assert.match(first.stdout, /AFTER FIX: still open/);
  const second = run(script, ['--alpha-root', stuck.root, '--fix', '--branch', 'b', '--state', s2]);
  assert.equal(second.status, 1);
  assert.match(second.stdout, /already tried on this source/);
  assert.doesNotMatch(second.stdout, /args:/);
});

test('--fix refuses a branch that is not a plain name, and needs one', () => {
  const { root } = fakeAlpha();
  assert.match(run(SCRIPT, ['--alpha-root', root, '--fix', '--branch', '../x']).stdout, /plain branch name/);
  assert.match(run(SCRIPT, ['--alpha-root', root, '--fix', '--state', join(root, 's.json')]).stdout, /--fix needs --branch/);
  const stale = fakeAlpha({ jsx: NEW_JSX, bundle: OLD_BUNDLE });
  const r = run(SCRIPT, ['--alpha-root', stale.root, '--fix', '--branch', 'b', '--state', join(stale.root, 's.json')]);
  assert.match(r.stdout, /needs a rebuild/);
  assert.match(r.stdout, /nothing here for --fix/);
});
