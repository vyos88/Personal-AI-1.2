import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS, expand, normalizeRecipe, run, walk } from '../src/agent/handlers/grow.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { ProtocolError } from '../src/common/protocol.js';

/** Every axis has real extent, which is the difference between 3D and a drawing. */
function spansAllAxes(bounds, min = 0.2) {
  return bounds.size.every((s) => s > min);
}

test('every preset grows something with volume', async () => {
  for (const name of Object.keys(PRESETS)) {
    const result = await run({ preset: name });
    assert.ok(result.stats.segments > 0, `${name} drew nothing`);
    assert.equal(result.nodes.length, result.stats.nodes);
    assert.equal(result.edges.length, result.stats.segments);
    assert.ok(spansAllAxes(result.stats.bounds), `${name} is flat: ${result.stats.bounds.size}`);

    // Every edge must join nodes that exist, or a renderer reads past the end.
    for (const [a, b, radius] of result.edges) {
      assert.ok(a >= 0 && a < result.nodes.length, `${name}: edge start ${a} out of range`);
      assert.ok(b >= 0 && b < result.nodes.length, `${name}: edge end ${b} out of range`);
      assert.ok(radius > 0, `${name}: non-positive radius`);
    }
  }
});

test('the same recipe and seed grows the same organism; a different seed does not', async () => {
  const a = await run({ preset: 'tree', seed: 7 });
  const b = await run({ preset: 'tree', seed: 7 });
  const c = await run({ preset: 'tree', seed: 8 });

  assert.deepEqual(a.nodes, b.nodes, 'same seed gave different geometry');
  assert.notDeepEqual(a.nodes, c.nodes, 'a different seed changed nothing');

  // The seed perturbs angles, not the grammar, so the structure is unchanged.
  assert.equal(a.stats.segments, c.stats.segments);
});

test('jitter zero is exactly repeatable and perfectly straight', async () => {
  const straight = await run({
    axiom: 'F', rules: {}, iterations: 0, jitter: 0, step: 1, kind: 'plant',
  });
  // One F, no rewrites: a single segment straight up the Y axis.
  assert.equal(straight.stats.segments, 1);
  assert.deepEqual(straight.nodes[1], [0, 1, 0]);
});

test('crawler carries legs on its last body segment too', async () => {
  // The first version of this preset delegated legs to a rule "L". A symbol
  // introduced on the final iteration has no rewrite left to expand it, so the
  // last segments came out legless and the creature was a comb. The legs are
  // literal now, and the arithmetic is the guard: one spine segment plus two
  // three-part legs is seven drawn segments per iteration, exactly.
  const { iterations } = PRESETS.crawler;
  const result = await run({ preset: 'crawler' });
  assert.equal(result.stats.segments, iterations * 7);
});

// There is deliberately no generic "nothing is stranded" test. A rule key that
// survives expansion is only a bug if it was meant to draw: the crawler's "S"
// survives as its growth tip and is correct, while "L" surviving meant legless
// segments. Telling those apart needs the grammar's intent, which is what the
// arithmetic in the crawler test above encodes. The test below documents the
// failure mode so the next person recognises it.

test('a rule key with no turtle meaning is caught when it survives', () => {
  // Guards the guard: the crawler's original "L" leg rule, reproduced.
  const recipe = normalizeRecipe({ axiom: 'S', rules: { S: 'F[+L]S', L: 'F&F' }, iterations: 3 });
  const symbols = expand(recipe, {});
  assert.ok(symbols.includes('L'), 'this grammar is supposed to strand an L');
  const { edges } = walk(recipe, symbols, {});
  // Three spine segments, but only two legs grew: the last L never expanded.
  assert.equal(edges.length, 3 + 2 * 2);
});

test('growth refuses to exceed maxSegments rather than truncating', async () => {
  await assert.rejects(
    () => run({ preset: 'tree', iterations: 5, maxSegments: 50 }),
    (error) => {
      assert.ok(error instanceof ProtocolError);
      assert.match(error.message, /maxSegments \(50\)/);
      assert.match(error.message, /iterations/, 'the message must name the knob to turn');
      return true;
    },
  );
});

test('expansion refuses to exceed the symbol budget', async () => {
  await assert.rejects(
    // Five new symbols per pass, twelve passes: 244 million characters.
    () => run({ axiom: 'F', rules: { F: 'FFFFF' }, iterations: 12 }),
    (error) => {
      assert.ok(error instanceof ProtocolError);
      assert.match(error.message, /symbols at iteration/);
      return true;
    },
  );
});

test('a recipe is validated before anything is grown', async () => {
  const cases = [
    [{ preset: 'triffid' }, /unknown preset "triffid"/],
    [{ axiom: '' }, /"axiom" must be a non-empty string/],
    [{ axiom: 'F', rules: { FF: 'F' } }, /must be a single character/],
    [{ axiom: 'F', rules: { F: 42 } }, /must expand to a string/],
    [{ axiom: 'F', format: 'gltf' }, /"format" must be one of/],
    [{ axiom: 'F', iterations: 99 }, /"iterations" must be between/],
    [{ axiom: 'F', angle: 'wide' }, /"angle" must be a finite number/],
    [{ axiom: 'F', taper: 0 }, /"taper" must be between/],
    [{ preset: 'fern', rules: [] }, /"rules" must be a JSON object/],
  ];
  for (const [payload, pattern] of cases) {
    await assert.rejects(() => run(payload), pattern, `accepted ${JSON.stringify(payload)}`);
  }
});

test('a branch that is never opened does not abort the rest of the organism', () => {
  // An unbalanced "]" is a typo in someone's grammar. Losing the whole result
  // over it would be a worse answer than growing what was asked for.
  const recipe = normalizeRecipe({ axiom: 'F]F]F', rules: {}, iterations: 0, jitter: 0 });
  const { edges } = walk(recipe, recipe.axiom, {});
  assert.equal(edges.length, 3);
});

test('a symbol with no turtle meaning is a named part, not an error', () => {
  const recipe = normalizeRecipe({ axiom: 'FXYZF', rules: {}, iterations: 0, jitter: 0 });
  const { edges } = walk(recipe, recipe.axiom, {});
  assert.equal(edges.length, 2);
});

test('an aborted task stops growing', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => run({ preset: 'tree' }, { signal: controller.signal }),
    /aborted/,
  );
});

test('format obj emits one-indexed Wavefront lines', async () => {
  const result = await run({ preset: 'crawler', format: 'obj' });
  assert.equal(result.nodes, undefined, 'obj should not also carry the raw skeleton');

  const lines = result.obj.trim().split('\n');
  const vertices = lines.filter((l) => l.startsWith('v '));
  const segments = lines.filter((l) => l.startsWith('l '));
  assert.equal(vertices.length, result.stats.nodes);
  assert.equal(segments.length, result.stats.segments);

  // OBJ indices start at 1, so a zero here means every file is off by one.
  for (const line of segments) {
    for (const index of line.slice(2).split(' ').map(Number)) {
      assert.ok(index >= 1 && index <= vertices.length, `index ${index} out of range`);
    }
  }
});

test('format stats returns the measurements without the geometry', async () => {
  const result = await run({ preset: 'fern', format: 'stats' });
  assert.equal(result.nodes, undefined);
  assert.equal(result.edges, undefined);
  assert.equal(result.obj, undefined);
  assert.ok(result.stats.segments > 0);
  assert.ok(result.recipe.name === 'fern');
});

test('a preset can be overridden without restating the grammar', async () => {
  const result = await run({ preset: 'tree', iterations: 2, seed: 42 });
  assert.equal(result.recipe.name, 'tree');
  assert.equal(result.recipe.iterations, 2);
  assert.equal(result.recipe.seed, 42);
  assert.equal(result.recipe.rules.F, PRESETS.tree.rules.F, 'the grammar should carry over');
});

test('grow is registered as a built-in and describes itself', () => {
  const registry = new HandlerRegistry();
  assert.ok(registry.has('grow'));
  const entry = registry.describe().find((h) => h.type === 'grow');
  assert.ok(entry.description.length > 0);
});

test('the result carries the recipe that produced it', async () => {
  // Whatever grew this has to be regrowable from what comes back, or the
  // output is a one-off after all.
  const result = await run({ preset: 'kelp', seed: 11 });
  const again = await run(result.recipe);
  assert.deepEqual(again.nodes, result.nodes);
});
