import { ProtocolError } from '../../common/protocol.js';

/**
 * Grows a plant or a creature from a recipe.
 *
 * The recipe is the point. A finished 3D model is megabytes of geometry that
 * has to be shipped, stored and version-controlled; the recipe that produces
 * it is a few hundred bytes of grammar that fits in a task payload, reads as a
 * diff, and regrows the same organism anywhere. So this handler takes the
 * description and returns the geometry, rather than moving geometry around.
 *
 * The grammar is an L-system: a start string and a set of rewrite rules,
 * applied a fixed number of times, then walked by a turtle in three dimensions.
 * That is the standard way natural branching is described, and it is why a fern
 * and a centipede are the same nine fields with different values — both are a
 * repeated part attached to itself at an angle.
 *
 * Output is a skeleton — nodes and edges with a radius each — not a surface
 * mesh. That is deliberate: a node/edge graph is what a topology renderer
 * already draws, it is an order of magnitude smaller than triangles, and
 * thickening a skeleton into tubes is the renderer's job and depends on its
 * level of detail. `format: 'obj'` also emits Wavefront OBJ lines for anything
 * that wants a file.
 *
 * On determinism: the same recipe gives the same organism within a given Node
 * build, and the jitter comes from a seeded generator rather than Math.random
 * so a seed is part of the recipe. Coordinates are rounded to four decimals,
 * which also makes the output stable across platforms in practice — though
 * Math.sin and Math.cos are not guaranteed bit-identical between engines, so
 * "identical everywhere" is a claim this deliberately does not make.
 */

export const type = 'grow';

export const description =
  'Grows a plant or creature from an L-system recipe and returns its skeleton as nodes and edges.';

/**
 * Recipes worth keeping. Each is a whole organism in nine fields, which is the
 * argument for the format: `crawler` differs from `fern` only in its rules.
 *
 * Turtle alphabet:
 *   F draw forward   f move without drawing
 *   + - yaw          & ^ pitch          / \ roll
 *   [ ] branch (push and pop position, orientation, thickness, parent node)
 *   ! taper          ' shorten the step
 */
export const PRESETS = Object.freeze({
  fern: {
    kind: 'plant',
    // A frond is close to planar, which is why the branch symbols stay in one
    // plane; the leading '/' spirals successive fronds off that plane instead,
    // which is what a real frond does and what keeps this from looking pressed.
    axiom: 'F',
    rules: { F: "/'F[+F]F[-F][F]" },
    iterations: 4,
    angle: 24,
    roll: 25,
    step: 1,
    taper: 0.78,
    jitter: 0.3,
  },
  tree: {
    kind: 'plant',
    // Three branches a third of a turn apart. Two branches make a flat Y from
    // every angle; three fill the volume, and the taper on both radius and
    // step is what stops the crown running away from the trunk.
    axiom: '!F',
    rules: { F: "!'F[/&F][//&F][///&F]" },
    iterations: 5,
    angle: 32,
    roll: 120,
    step: 1.6,
    taper: 0.76,
    jitter: 0.25,
  },
  kelp: {
    kind: 'plant',
    // Almost no branching and a persistent roll: the curl is the organism.
    axiom: 'F',
    rules: { F: 'F/&F[+F]\\^F' },
    iterations: 4,
    angle: 12,
    roll: 24,
    step: 1,
    taper: 0.94,
    jitter: 0.2,
  },
  crawler: {
    kind: 'animal',
    // A spine that appends one more segment per iteration, so this grows
    // linearly rather than exponentially: iterations are body segments, each
    // carrying a pair of legs. An arthropod skeleton, not a rigged animal.
    //
    // The legs are written out as F'F'F rather than delegated to a rule. A
    // symbol introduced on the LAST iteration has no rewrite left to expand
    // it, so a leg rule would silently produce legless final segments — which
    // is exactly what the first version of this preset did.
    axiom: 'S',
    rules: { S: "!F[+&F'F'F][-&F'F'F]S" },
    iterations: 11,
    angle: 70,
    roll: 0,
    step: 1.1,
    taper: 0.98,
    jitter: 0.22,
  },
});

const LIMITS = Object.freeze({
  iterations: 12,
  symbols: 250_000,
  segments: 60_000,
  ruleKeys: 16,
  ruleLength: 512,
  axiomLength: 256,
});

/** Small seeded generator, so a seed is part of the recipe rather than luck. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rotate `v` about `axis` (unit) by `rad`. Rodrigues, so no matrices to keep. */
function rotate(v, axis, rad) {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const [x, y, z] = v;
  const [a, b, d] = axis;
  const dot = x * a + y * b + z * d;
  return [
    x * c + (b * z - d * y) * s + a * dot * (1 - c),
    y * c + (d * x - a * z) * s + b * dot * (1 - c),
    z * c + (a * y - b * x) * s + d * dot * (1 - c),
  ];
}

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 0)) return [0, 1, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

const round4 = (n) => Math.round(n * 10000) / 10000;

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(`"${field}" must be a JSON object`);
  }
  return value;
}

function num(value, field, { min, max, fallback }) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError(`"${field}" must be a finite number`);
  }
  if (value < min || value > max) {
    throw new ProtocolError(`"${field}" must be between ${min} and ${max}`);
  }
  return value;
}

/**
 * Turn a payload into a complete recipe.
 *
 * A preset name plus overrides is the common case — "the tree, but shorter and
 * with a different seed" should not mean restating the grammar.
 */
export function normalizeRecipe(payload = {}) {
  requireObject(payload, 'payload');

  const presetName = payload.preset ?? (payload.axiom ? null : 'fern');
  if (presetName !== null && !Object.hasOwn(PRESETS, presetName)) {
    throw new ProtocolError(
      `unknown preset "${presetName}". Known: ${Object.keys(PRESETS).join(', ')}`,
    );
  }
  const base = presetName === null ? {} : PRESETS[presetName];
  const merged = { ...base, ...payload };

  const axiom = String(merged.axiom ?? '');
  if (!axiom) throw new ProtocolError('"axiom" must be a non-empty string');
  if (axiom.length > LIMITS.axiomLength) {
    throw new ProtocolError(`"axiom" exceeds ${LIMITS.axiomLength} characters`);
  }

  const rules = requireObject(merged.rules ?? {}, 'rules');
  const ruleKeys = Object.keys(rules);
  if (ruleKeys.length > LIMITS.ruleKeys) {
    throw new ProtocolError(`at most ${LIMITS.ruleKeys} rules`);
  }
  for (const key of ruleKeys) {
    if (key.length !== 1) {
      throw new ProtocolError(`rule key "${key}" must be a single character`);
    }
    const body = rules[key];
    if (typeof body !== 'string') {
      throw new ProtocolError(`rule "${key}" must expand to a string`);
    }
    if (body.length > LIMITS.ruleLength) {
      throw new ProtocolError(`rule "${key}" exceeds ${LIMITS.ruleLength} characters`);
    }
  }

  const format = merged.format ?? 'skeleton';
  if (!['skeleton', 'obj', 'stats'].includes(format)) {
    throw new ProtocolError('"format" must be one of: skeleton, obj, stats');
  }

  return {
    kind: merged.kind === 'animal' ? 'animal' : 'plant',
    name: presetName ?? 'custom',
    axiom,
    rules: { ...rules },
    iterations: Math.floor(num(merged.iterations, 'iterations', { min: 0, max: LIMITS.iterations, fallback: 4 })),
    angle: num(merged.angle, 'angle', { min: 0, max: 180, fallback: 25 }),
    roll: num(merged.roll, 'roll', { min: 0, max: 360, fallback: 0 }),
    step: num(merged.step, 'step', { min: 0.001, max: 1000, fallback: 1 }),
    taper: num(merged.taper, 'taper', { min: 0.1, max: 1, fallback: 0.8 }),
    jitter: num(merged.jitter, 'jitter', { min: 0, max: 1, fallback: 0 }),
    radius: num(merged.radius, 'radius', { min: 0.0001, max: 100, fallback: 0.08 }),
    seed: Math.floor(num(merged.seed, 'seed', { min: 0, max: 2 ** 31 - 1, fallback: 1 })),
    maxSegments: Math.floor(
      num(merged.maxSegments, 'maxSegments', { min: 1, max: LIMITS.segments, fallback: 20_000 }),
    ),
    format,
  };
}

/**
 * Apply the rules `iterations` times.
 *
 * The cap is checked before each pass rather than after: an L-system grows
 * exponentially, so the pass that would blow the budget is the one that must
 * not run. It throws rather than truncating, because half an organism is a
 * misleading answer to a recipe — and the message names the knob to turn.
 */
export function expand(recipe, { signal } = {}) {
  let current = recipe.axiom;
  for (let pass = 0; pass < recipe.iterations; pass += 1) {
    if (signal?.aborted) throw new Error('aborted');
    let next = '';
    for (const ch of current) {
      next += Object.hasOwn(recipe.rules, ch) ? recipe.rules[ch] : ch;
      if (next.length > LIMITS.symbols) {
        throw new ProtocolError(
          `expansion exceeded ${LIMITS.symbols} symbols at iteration ${pass + 1} of ` +
            `${recipe.iterations}. Lower "iterations", or shorten the rules.`,
        );
      }
    }
    current = next;
  }
  return current;
}

/** Walk the expanded string, emitting nodes and edges. */
export function walk(recipe, symbols, { signal } = {}) {
  const rnd = mulberry32(recipe.seed);
  const yaw = (recipe.angle * Math.PI) / 180;
  const roll = (recipe.roll * Math.PI) / 180;

  const nodes = [[0, 0, 0]];
  const edges = [];
  const stack = [];

  let pos = [0, 0, 0];
  let heading = [0, 1, 0];
  let left = [-1, 0, 0];
  let up = [0, 0, 1];
  let step = recipe.step;
  let radius = recipe.radius;
  let parent = 0;

  // Jitter is applied to the angle actually turned, not to the finished
  // position: bending the growth direction is what makes a plant look grown
  // rather than drawn, because the error accumulates down the branch.
  const wobble = (rad) => (recipe.jitter === 0 ? rad : rad * (1 + recipe.jitter * (rnd() * 2 - 1)));

  // And a straight run has to wander, or it is a ruler. Turning only at turn
  // symbols leaves a trunk perfectly straight however much jitter is set,
  // which is the single thing that most gives a generated plant away. The
  // whole frame is rotated so heading, left and up stay orthonormal.
  const WANDER_MAX = 0.14; // radians at jitter = 1
  const wander = () => {
    if (recipe.jitter === 0) return;
    const a = recipe.jitter * WANDER_MAX * (rnd() * 2 - 1);
    const b = recipe.jitter * WANDER_MAX * (rnd() * 2 - 1);
    heading = normalize(rotate(heading, left, a));
    up = normalize(rotate(up, left, a));
    heading = normalize(rotate(heading, up, b));
    left = normalize(rotate(left, up, b));
  };

  let i = 0;
  for (const ch of symbols) {
    if ((i += 1) % 4096 === 0 && signal?.aborted) throw new Error('aborted');

    switch (ch) {
      case 'F':
      case 'f': {
        wander();
        const d = step * (recipe.jitter === 0 ? 1 : 1 + recipe.jitter * (rnd() * 2 - 1) * 0.5);
        pos = [pos[0] + heading[0] * d, pos[1] + heading[1] * d, pos[2] + heading[2] * d];
        nodes.push([round4(pos[0]), round4(pos[1]), round4(pos[2])]);
        const index = nodes.length - 1;
        if (ch === 'F') {
          if (edges.length >= recipe.maxSegments) {
            throw new ProtocolError(
              `exceeded maxSegments (${recipe.maxSegments}). Lower "iterations", or raise ` +
                `"maxSegments" up to ${LIMITS.segments}.`,
            );
          }
          edges.push([parent, index, round4(radius)]);
        }
        parent = index;
        break;
      }
      case '+':
        heading = normalize(rotate(heading, up, wobble(yaw)));
        left = normalize(rotate(left, up, wobble(yaw)));
        break;
      case '-':
        heading = normalize(rotate(heading, up, -wobble(yaw)));
        left = normalize(rotate(left, up, -wobble(yaw)));
        break;
      case '&':
        heading = normalize(rotate(heading, left, wobble(yaw)));
        up = normalize(rotate(up, left, wobble(yaw)));
        break;
      case '^':
        heading = normalize(rotate(heading, left, -wobble(yaw)));
        up = normalize(rotate(up, left, -wobble(yaw)));
        break;
      case '/':
        left = normalize(rotate(left, heading, roll));
        up = normalize(rotate(up, heading, roll));
        break;
      case '\\':
        left = normalize(rotate(left, heading, -roll));
        up = normalize(rotate(up, heading, -roll));
        break;
      case '!':
        radius *= recipe.taper;
        break;
      case "'":
        step *= recipe.taper;
        break;
      case '[':
        stack.push({ pos, heading, left, up, step, radius, parent });
        break;
      case ']': {
        const saved = stack.pop();
        // An unbalanced ']' is a typo in the grammar, not a reason to stop:
        // the rest of the organism is still worth returning.
        if (saved) ({ pos, heading, left, up, step, radius, parent } = saved);
        break;
      }
      default:
        break; // Any other symbol is a named part with no turtle meaning.
    }
  }

  return { nodes, edges };
}

function boundsOf(nodes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const n of nodes) {
    for (let a = 0; a < 3; a += 1) {
      if (n[a] < min[a]) min[a] = n[a];
      if (n[a] > max[a]) max[a] = n[a];
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return {
    min: min.map(round4),
    max: max.map(round4),
    size: size.map(round4),
    // What a viewer needs to frame the thing without measuring it again.
    center: [round4((min[0] + max[0]) / 2), round4((min[1] + max[1]) / 2), round4((min[2] + max[2]) / 2)],
    radius: round4(Math.hypot(...size) / 2),
  };
}

function toObj(recipe, nodes, edges) {
  const lines = [`# ${recipe.kind} "${recipe.name}" grown by alpha-tunnel`, `# seed ${recipe.seed}`];
  for (const [x, y, z] of nodes) lines.push(`v ${x} ${y} ${z}`);
  for (const [a, b] of edges) lines.push(`l ${a + 1} ${b + 1}`); // OBJ is 1-indexed
  return `${lines.join('\n')}\n`;
}

export async function run(payload, context = {}) {
  const { signal, log } = context;
  const recipe = normalizeRecipe(payload);

  const symbols = expand(recipe, { signal });
  const { nodes, edges } = walk(recipe, symbols, { signal });

  const stats = {
    symbols: symbols.length,
    nodes: nodes.length,
    segments: edges.length,
    bounds: boundsOf(nodes),
  };
  log?.(`grew ${recipe.kind} "${recipe.name}" seed ${recipe.seed}: ${stats.segments} segments`);

  if (recipe.format === 'stats') return { recipe, stats };
  if (recipe.format === 'obj') return { recipe, stats, obj: toObj(recipe, nodes, edges) };
  return { recipe, stats, nodes, edges };
}
