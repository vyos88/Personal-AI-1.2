/**
 * Rebuilds docs/deck/alpha-tunnel.pptx — the deck explaining load-aware
 * placement across the Alpha host and the laptops.
 *
 * Run it from this directory, not the repo root:
 *
 *     cd docs/deck && npm install && npm run build
 *
 * pptxgenjs is a devDependency of *this directory only*. The repo root has no
 * dependencies and must keep none: alpha-tunnel is meant to be cloned onto a
 * machine and run with nothing but node, and a deck generator is no reason to
 * change that. Nothing under src/ or test/ imports this file.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pptxgen from 'pptxgenjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

// Read rather than hardcoded, so the deck cannot claim one release while the
// machines report another — the drift this project exists to make visible.
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

// The release before agents could report load at all. Used in the drift
// example, where the point is that an older machine shows "-" under CPU.
const PRE_LOAD_VERSION = '0.2.0';

/**
 * The number of passing tests, by running them.
 *
 * The closing slide claims a figure, and a figure typed into a slide is stale
 * the moment somebody adds a test. Running the suite makes the claim true by
 * construction, and refuses to build a deck that would assert a green suite
 * over a red one.
 */
function passingTestCount() {
  const files = readdirSync(join(ROOT, 'test'))
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => join('test', name))
    .sort();

  let output;
  try {
    output = execFileSync(process.execPath, ['--test', ...files], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const failed = /^# fail (\d+)$/m.exec(error.stdout ?? '');
    throw new Error(
      `the test suite is not green (${failed ? `${failed[1]} failing` : error.message}), ` +
        'so this deck would claim something untrue. Fix the suite, then rebuild.',
    );
  }

  const passed = /^# pass (\d+)$/m.exec(output);
  if (!passed) throw new Error('could not read a pass count out of the test output');
  return Number(passed[1]);
}

const TEST_COUNT = passingTestCount();

// Hot/cool is the subject matter, so it is the palette: slate carries the
// structure, teal means a machine with capacity, ember means one at full tilt.
const INK = '1B2430';
const INK_SOFT = '32424F';
const PAPER = 'FFFFFF';
const MIST = 'EDF1F4';
const BODY = '3C4A59';
const MUTED = '78889A';
const COOL = '0E9594';
const COOL_SOFT = 'BFE0DD';
const HOT = 'C9472A';
const HOT_SOFT = 'EFC9BE';

const HEAD = 'Cambria';
const TEXT = 'Calibri';
const MONO = 'Courier New';

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE'; // 13.3 x 7.5
pres.author = 'alpha-tunnel';
pres.title = `alpha-tunnel ${VERSION} - load-aware placement`;

const W = 13.3;
const M = 0.7;
const CW = W - M * 2; // content width
const KICKER_Y = 0.42;
const TITLE_Y = 0.76;
const TOP = 1.95; // where slide content begins

// ---------------------------------------------------------------- primitives

function title(slide, text, { color = INK } = {}) {
  slide.addText(text, {
    x: M, y: TITLE_Y, w: CW, h: 0.95,
    fontFace: HEAD, fontSize: 32, bold: true, color,
    align: 'left', valign: 'middle', isTextBox: true, margin: 0,
  });
}

function kicker(slide, text, { color = COOL } = {}) {
  slide.addText(text.toUpperCase(), {
    x: M, y: KICKER_Y, w: CW, h: 0.3,
    fontFace: TEXT, fontSize: 11, bold: true, color, charSpacing: 2,
    valign: 'middle', isTextBox: true, margin: 0,
  });
}

function body(slide, text, opts) {
  slide.addText(text, {
    fontFace: TEXT, fontSize: 15, color: BODY, valign: 'top',
    isTextBox: true, margin: 0, lineSpacingMultiple: 1.25, ...opts,
  });
}

function card(slide, { x, y, w, h, fill = MIST, line = null }) {
  slide.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.06,
    fill: { color: fill },
    line: line ? { color: line, width: 1 } : { color: fill, width: 0 },
  });
}

function heading(slide, text, { x, y, w, size = 20, color = INK }) {
  slide.addText(text, {
    x, y, w, h: 0.42,
    fontFace: HEAD, fontSize: size, bold: true, color,
    isTextBox: true, margin: 0, valign: 'middle',
  });
}

/** A machine as it appears in `alpha-admin agents`: name, load meter, leases. */
function machineCard(slide, { x, y, w = 4.2, name, sub, pct, hot, note }) {
  const h = 1.6;
  const accent = hot ? HOT : COOL;
  const tint = hot ? HOT_SOFT : COOL_SOFT;
  card(slide, { x, y, w, h, fill: PAPER, line: tint });

  slide.addText(name, {
    x: x + 0.28, y: y + 0.18, w: w - 1.75, h: 0.34,
    fontFace: TEXT, fontSize: 15, bold: true, color: INK,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  slide.addText(sub, {
    x: x + 0.28, y: y + 0.52, w: w - 1.75, h: 0.26,
    fontFace: TEXT, fontSize: 11, color: MUTED,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  slide.addText(`${pct}%`, {
    x: x + w - 1.6, y: y + 0.18, w: 1.32, h: 0.5,
    fontFace: HEAD, fontSize: 24, bold: true, color: accent,
    align: 'right', isTextBox: true, margin: 0, valign: 'middle',
  });

  // Load meter: a track, and a fill whose width is the reading itself.
  const trackX = x + 0.28;
  const trackW = w - 0.56;
  slide.addShape(pres.ShapeType.roundRect, {
    x: trackX, y: y + 0.95, w: trackW, h: 0.15, rectRadius: 0.07,
    fill: { color: MIST }, line: { color: MIST, width: 0 },
  });
  slide.addShape(pres.ShapeType.roundRect, {
    x: trackX, y: y + 0.95, w: Math.max(0.16, trackW * (pct / 100)), h: 0.15, rectRadius: 0.07,
    fill: { color: accent }, line: { color: accent, width: 0 },
  });
  slide.addText(note, {
    x: trackX, y: y + 1.16, w: trackW, h: 0.32,
    fontFace: TEXT, fontSize: 11, color: hot ? HOT : BODY,
    isTextBox: true, margin: 0, valign: 'middle',
  });
}

/** A one-line version of the same idea, for side-by-side comparisons. */
function miniMachine(slide, { x, y, w, name, pct, hot, tally }) {
  const accent = hot ? HOT : COOL;
  slide.addText(name, {
    x, y, w: 1.55, h: 0.3,
    fontFace: TEXT, fontSize: 12, bold: true, color: INK,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  const trackX = x + 1.6;
  const trackW = w - 1.6 - 1.5;
  slide.addShape(pres.ShapeType.roundRect, {
    x: trackX, y: y + 0.09, w: trackW, h: 0.13, rectRadius: 0.06,
    fill: { color: MIST }, line: { color: MIST, width: 0 },
  });
  slide.addShape(pres.ShapeType.roundRect, {
    x: trackX, y: y + 0.09, w: Math.max(0.14, trackW * (pct / 100)), h: 0.13, rectRadius: 0.06,
    fill: { color: accent }, line: { color: accent, width: 0 },
  });
  slide.addText(`${pct}%   ${tally}`, {
    x: x + w - 1.45, y, w: 1.45, h: 0.3,
    fontFace: TEXT, fontSize: 12, color: accent, bold: true, align: 'right',
    isTextBox: true, margin: 0, valign: 'middle',
  });
}

/** Terminal output, in the one place a monospace block genuinely belongs. */
function terminal(slide, { x, y, w, lines, size = 10.5 }) {
  // Sized from the line count rather than guessed at, so a two-line block does
  // not sit in a box built for six.
  const lineH = (size * 1.19) / 72;
  const h = 0.4 + lines.length * lineH;
  card(slide, { x, y, w, h, fill: INK });
  slide.addText(lines.join('\n'), {
    x: x + 0.24, y: y + 0.2, w: w - 0.48, h: h - 0.4,
    fontFace: MONO, fontSize: size, color: 'D8E2E9',
    isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.15,
  });
  return h;
}

function numberedRow(slide, { x, y, w, n, head, text, color = COOL }) {
  slide.addShape(pres.ShapeType.ellipse, {
    x, y, w: 0.46, h: 0.46, fill: { color }, line: { color, width: 0 },
  });
  slide.addText(String(n), {
    x, y, w: 0.46, h: 0.46,
    fontFace: TEXT, fontSize: 15, bold: true, color: PAPER,
    align: 'center', valign: 'middle', isTextBox: true, margin: 0,
  });
  slide.addText(head, {
    x: x + 0.7, y: y - 0.03, w: w - 0.7, h: 0.34,
    fontFace: TEXT, fontSize: 16, bold: true, color: INK,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  slide.addText(text, {
    x: x + 0.7, y: y + 0.32, w: w - 0.7, h: 0.72,
    fontFace: TEXT, fontSize: 13, color: BODY,
    isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.2,
  });
}

const lightSlide = () => {
  const s = pres.addSlide();
  s.background = { color: PAPER };
  return s;
};
const darkSlide = () => {
  const s = pres.addSlide();
  s.background = { color: INK };
  return s;
};

// ------------------------------------------------------------------ 1. title
{
  const s = darkSlide();
  s.addText('alpha-tunnel', {
    x: M, y: 2.05, w: 9, h: 0.5,
    fontFace: TEXT, fontSize: 17, color: COOL, charSpacing: 3,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText('Load-aware placement', {
    x: M, y: 2.5, w: 11.4, h: 1.0,
    fontFace: HEAD, fontSize: 52, bold: true, color: PAPER,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText(
    'Why both laptops ended up pinned, and what now decides which machine takes the work.',
    {
      x: M, y: 3.6, w: 9.4, h: 0.9,
      fontFace: TEXT, fontSize: 17, color: '9FB0BE',
      isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.3,
    },
  );
  s.addShape(pres.ShapeType.roundRect, {
    x: M, y: 4.95, w: 2.05, h: 0.44, rectRadius: 0.08,
    fill: { color: INK_SOFT }, line: { color: INK_SOFT, width: 0 },
  });
  s.addText(`Release ${VERSION}`, {
    x: M, y: 4.95, w: 2.05, h: 0.44,
    fontFace: TEXT, fontSize: 13, bold: true, color: PAPER,
    align: 'center', valign: 'middle', isTextBox: true, margin: 0,
  });
  s.addText('Alpha host  ·  two laptops  ·  one coordinator', {
    x: 2.95, y: 4.95, w: 6, h: 0.44,
    fontFace: TEXT, fontSize: 13, color: MUTED,
    valign: 'middle', isTextBox: true, margin: 0,
  });
  s.addNotes(
    `alpha-tunnel ${VERSION}. The subject is task placement across the Alpha host and the two laptops. ` +
    'Everything shown was measured against a real coordinator over loopback, not the live tailnet.',
  );
}

// ---------------------------------------------------------------- 2. problem
{
  const s = lightSlide();
  kicker(s, 'The symptom');
  title(s, 'Both laptops at full tilt, and neither knew');

  body(s,
    'Work kept landing on a machine that was already saturated while its neighbour sat idle. ' +
    'Nothing in the coordinator could tell the two apart.',
    { x: M, y: TOP, w: CW, h: 0.75, fontSize: 16 });

  machineCard(s, {
    x: M, y: 2.95, w: 5.75, name: 'laptop-A', sub: '4 cores · 16 GB',
    pct: 97, hot: true, note: 'took 6 of the last 10 tasks',
  });
  machineCard(s, {
    x: M + 6.15, y: 2.95, w: 5.75, name: 'laptop-B', sub: '8 cores · 32 GB',
    pct: 94, hot: true, note: 'and the other 4 — so it pinned too',
  });

  card(s, { x: M, y: 4.95, w: CW, h: 1.6 });
  s.addText('Free RAM says nothing about whether a machine can take on more.', {
    x: M + 0.4, y: 5.18, w: CW - 0.8, h: 0.4,
    fontFace: TEXT, fontSize: 17, bold: true, color: INK,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText(
    'A laptop running its owner\'s build at 100% CPU still reports gigabytes free. To a coordinator ' +
    'that only knew about memory, it looked exactly as good a target as an idle one.',
    {
      x: M + 0.4, y: 5.6, w: CW - 0.8, h: 0.75,
      fontFace: TEXT, fontSize: 14, color: BODY,
      isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.25,
    },
  );
  s.addNotes('The complaint as it was reported: this laptop is at full load, why is the other doing the same?');
}

// ------------------------------------------------------------------- 3. why
{
  const s = lightSlide();
  kicker(s, 'Root cause');
  title(s, 'Three faults, none visible from one machine');

  numberedRow(s, {
    x: M, y: TOP + 0.15, w: CW, n: 1, color: HOT,
    head: 'Placement knew only about RAM',
    text: 'The registry admitted a task if the agent had the free memory it asked for. CPU was never part of the decision.',
  });
  numberedRow(s, {
    x: M, y: TOP + 1.65, w: CW, n: 2, color: HOT,
    head: 'The first agent to ask won every dispatch',
    text: 'With several agents parked on long polls, the queue took the first waiter in insertion order — whichever machine had parked earliest, however busy it already was.',
  });
  numberedRow(s, {
    x: M, y: TOP + 3.15, w: CW, n: 3, color: HOT,
    head: 'Ordinary tasks were tracked against nobody',
    text: 'Only tasks naming minMemoryMB reserved anything, so a burst of untagged work all landed before any of it moved a reading.',
  });

  s.addNotes('Each is independently enough to unbalance the fleet; together they guarantee it.');
}

// ------------------------------------------------------------------ 4. fix
{
  const s = lightSlide();
  kicker(s, 'The fix');
  title(s, 'Two halves, because one is not enough');

  const cardY = TOP;
  const cardH = 4.05;
  const colW = 5.75;

  card(s, { x: M, y: cardY, w: colW, h: cardH });
  heading(s, 'On the host', { x: M + 0.4, y: cardY + 0.3, w: colW - 0.8 });
  s.addText(
    'registry.rank() orders every candidate agent, and the queue hands the task to the best of them ' +
    'rather than to whoever asked first.',
    {
      x: M + 0.4, y: cardY + 0.85, w: colW - 0.8, h: 1.0,
      fontFace: TEXT, fontSize: 14, color: BODY,
      isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.25,
    },
  );
  s.addText('Leases already held', {
    x: M + 0.4, y: cardY + 2.0, w: colW - 0.8, h: 0.3,
    fontFace: TEXT, fontSize: 14, bold: true, color: INK,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText('Exact, immediate, and it cannot go stale.', {
    x: M + 0.4, y: cardY + 2.32, w: colW - 0.8, h: 0.3,
    fontFace: TEXT, fontSize: 13, color: BODY,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText('Then reported CPU load', {
    x: M + 0.4, y: cardY + 2.85, w: colW - 0.8, h: 0.3,
    fontFace: TEXT, fontSize: 14, bold: true, color: INK,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText('Between machines holding the same work, the cooler one wins.', {
    x: M + 0.4, y: cardY + 3.17, w: colW - 0.8, h: 0.6,
    fontFace: TEXT, fontSize: 13, color: BODY,
    isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.2,
  });

  card(s, { x: M + 6.15, y: cardY, w: colW, h: cardH });
  heading(s, 'On the agent', { x: M + 6.55, y: cardY + 0.3, w: colW - 0.8 });
  s.addText(
    'Above ALPHA_AGENT_MAX_LOAD (0.85 of its cores) a machine stops asking for work, so the next ' +
    'task goes to one with cores free.',
    {
      x: M + 6.55, y: cardY + 0.85, w: colW - 0.8, h: 1.0,
      fontFace: TEXT, fontSize: 14, color: BODY,
      isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.25,
    },
  );
  s.addText('The host can only rank agents that ask', {
    x: M + 6.55, y: cardY + 2.0, w: colW - 0.8, h: 0.3,
    fontFace: TEXT, fontSize: 14, bold: true, color: INK,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText('A pinned laptop has to take itself out of the running.', {
    x: M + 6.55, y: cardY + 2.32, w: colW - 0.8, h: 0.3,
    fontFace: TEXT, fontSize: 13, color: BODY,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText('It never goes quiet', {
    x: M + 6.55, y: cardY + 2.85, w: colW - 0.8, h: 0.3,
    fontFace: TEXT, fontSize: 14, bold: true, color: INK,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText('It keeps heartbeating, and takes work again the moment its load drops.', {
    x: M + 6.55, y: cardY + 3.17, w: colW - 0.8, h: 0.6,
    fontFace: TEXT, fontSize: 13, color: BODY,
    isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.2,
  });

  s.addText('This is a pause, never a refusal.', {
    x: M, y: 6.25, w: CW, h: 0.4,
    fontFace: TEXT, fontSize: 15, italic: true, color: COOL,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addNotes('Host-side ranking alone cannot help when the busy machine is the only one asking.');
}

// --------------------------------------------------------- 5. the wire shape
{
  const s = lightSlide();
  kicker(s, 'What crosses the wire');
  title(s, 'The agent dials out, and says how busy it is');

  const boxY = 2.25;
  const boxH = 3.5;
  card(s, { x: M, y: boxY, w: 3.5, h: boxH, fill: INK });
  s.addText('HOST', {
    x: M + 0.3, y: boxY + 0.3, w: 2.9, h: 0.34,
    fontFace: TEXT, fontSize: 12, bold: true, color: COOL, charSpacing: 2,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText('Alpha machine', {
    x: M + 0.3, y: boxY + 0.66, w: 2.9, h: 0.4,
    fontFace: HEAD, fontSize: 19, bold: true, color: PAPER,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText(
    'task queue\nagent registry\nusers · keys · scopes\nranks the agents',
    {
      x: M + 0.3, y: boxY + 1.25, w: 2.9, h: 1.6,
      fontFace: TEXT, fontSize: 13, color: '9FB0BE',
      isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.35,
    },
  );
  s.addText('listens', {
    x: M + 0.3, y: boxY + 2.95, w: 2.9, h: 0.3,
    fontFace: TEXT, fontSize: 11, italic: true, color: MUTED,
    isTextBox: true, margin: 0, valign: 'middle',
  });

  const agentX = 9.1;
  card(s, { x: agentX, y: boxY, w: 3.5, h: boxH, fill: INK });
  s.addText('AGENT', {
    x: agentX + 0.3, y: boxY + 0.3, w: 2.9, h: 0.34,
    fontFace: TEXT, fontSize: 12, bold: true, color: COOL, charSpacing: 2,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText('laptop', {
    x: agentX + 0.3, y: boxY + 0.66, w: 2.9, h: 0.4,
    fontFace: HEAD, fontSize: 19, bold: true, color: PAPER,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText(
    'runs handlers\nmeasures its own CPU\nstands aside when hot\nno open port',
    {
      x: agentX + 0.3, y: boxY + 1.25, w: 2.9, h: 1.6,
      fontFace: TEXT, fontSize: 13, color: '9FB0BE',
      isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.35,
    },
  );
  s.addText('dials out only', {
    x: agentX + 0.3, y: boxY + 2.95, w: 2.9, h: 0.3,
    fontFace: TEXT, fontSize: 11, italic: true, color: MUTED,
    isTextBox: true, margin: 0, valign: 'middle',
  });

  const laneX = M + 3.5 + 0.35;
  const laneW = agentX - laneX - 0.35;
  const wires = [
    { label: 'POST /register', toHost: true, accent: false },
    { label: 'POST /heartbeat   ·   RAM + CPU, every 20s', toHost: true, accent: false },
    { label: 'GET /tasks/next?load=0.12', toHost: true, accent: true },
    { label: '200 { task }', toHost: false, accent: false },
    { label: 'POST /result', toHost: true, accent: false },
  ];
  wires.forEach((wire, i) => {
    const y = boxY + 0.62 + i * 0.66;
    const color = wire.accent ? COOL : MUTED;
    s.addText(wire.label, {
      x: laneX, y: y - 0.32, w: laneW, h: 0.28,
      fontFace: TEXT, fontSize: wire.accent ? 12 : 11.5,
      bold: wire.accent, color: wire.accent ? COOL : BODY,
      align: 'center', isTextBox: true, margin: 0, valign: 'middle',
    });
    s.addShape(pres.ShapeType.line, {
      x: laneX, y, w: laneW, h: 0,
      line: {
        color, width: wire.accent ? 2.25 : 1.5,
        beginArrowType: wire.toHost ? 'triangle' : 'none',
        endArrowType: wire.toHost ? 'none' : 'triangle',
      },
    });
  });

  s.addText(
    'The poll is the moment an agent asks for work, so it carries the load with it. The host ranks on ' +
    'what the machine is like now, not on a heartbeat up to twenty seconds old.',
    {
      x: M, y: 6.05, w: CW, h: 0.8,
      fontFace: TEXT, fontSize: 14, color: BODY,
      isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.25,
    },
  );
  s.addNotes('Every connection is outbound from the agent: no open port, no inbound firewall rule on the laptop.');
}

// ------------------------------------------------------------- 6. the rules
{
  const s = lightSlide();
  kicker(s, 'How a machine is chosen');
  title(s, 'Work in hand first, then how hot it is');

  numberedRow(s, {
    x: M, y: TOP + 0.1, w: 7.6, n: 1,
    head: 'Leases the agent already holds',
    text: 'A task handed over a millisecond ago has not moved any reading yet. Counting it is the only signal that is exact and immediate.',
  });
  numberedRow(s, {
    x: M, y: TOP + 1.55, w: 7.6, n: 2,
    head: 'Then its reported load',
    text: 'Among machines holding the same amount of work, the one with cores free wins.',
  });

  card(s, { x: M, y: TOP + 2.85, w: 7.6, h: 1.15, fill: MIST });
  s.addText(
    'An agent holding a task always ranks below an idle one — however quiet it claims to be.',
    {
      x: M + 0.35, y: TOP + 3.05, w: 6.9, h: 0.75,
      fontFace: TEXT, fontSize: 14, color: INK, bold: true,
      isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.25,
    },
  );

  const sideX = M + 8.05;
  const sideW = CW - 8.05;
  card(s, { x: sideX, y: TOP + 0.1, w: sideW, h: 3.9, fill: INK });
  s.addText('The invariant', {
    x: sideX + 0.35, y: TOP + 0.42, w: sideW - 0.7, h: 0.4,
    fontFace: HEAD, fontSize: 19, bold: true, color: PAPER,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText('Unknown load is never read as idle.', {
    x: sideX + 0.35, y: TOP + 0.95, w: sideW - 0.7, h: 0.7,
    fontFace: TEXT, fontSize: 15, bold: true, color: COOL,
    isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.2,
  });
  s.addText(
    'A missing report, a machine that cannot measure itself, and a stale report all rank mid-scale.\n\n' +
    'Reading any of them as zero would make the quietest reporter beat the quietest machine.',
    {
      x: sideX + 0.35, y: TOP + 1.75, w: sideW - 0.7, h: 2.0,
      fontFace: TEXT, fontSize: 13, color: '9FB0BE',
      isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.25,
    },
  );
  s.addNotes('Windows has no load average at all, so "cannot measure itself" is a real case, not a hypothetical.');
}

// ---------------------------------------------------------------- 7. results
{
  const s = lightSlide();
  kicker(s, 'Measured');
  title(s, 'Two agents, one coordinator, ten tasks');

  const colW = 5.75;
  const colY = TOP + 0.1;
  const colH = 3.5;

  card(s, { x: M, y: colY, w: colW, h: colH, fill: PAPER, line: HOT_SOFT });
  s.addText('While laptop-A was pinned', {
    x: M + 0.4, y: colY + 0.28, w: colW - 0.8, h: 0.34,
    fontFace: TEXT, fontSize: 13, bold: true, color: HOT,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText('0 / 10', {
    x: M + 0.4, y: colY + 0.68, w: colW - 0.8, h: 0.95,
    fontFace: HEAD, fontSize: 54, bold: true, color: INK,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText('laptop-A / laptop-B — all ten to the machine with cores free.', {
    x: M + 0.4, y: colY + 1.68, w: colW - 0.8, h: 0.35,
    fontFace: TEXT, fontSize: 13, color: BODY,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  miniMachine(s, { x: M + 0.4, y: colY + 2.2, w: colW - 0.8, name: 'laptop-A', pct: 97, hot: true, tally: '0 tasks' });
  miniMachine(s, { x: M + 0.4, y: colY + 2.72, w: colW - 0.8, name: 'laptop-B', pct: 8, hot: false, tally: '10 tasks' });

  const rx = M + 6.15;
  card(s, { x: rx, y: colY, w: colW, h: colH, fill: PAPER, line: COOL_SOFT });
  s.addText('After laptop-A recovered', {
    x: rx + 0.4, y: colY + 0.28, w: colW - 0.8, h: 0.34,
    fontFace: TEXT, fontSize: 13, bold: true, color: COOL,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText('3 / 3', {
    x: rx + 0.4, y: colY + 0.68, w: colW - 0.8, h: 0.95,
    fontFace: HEAD, fontSize: 54, bold: true, color: INK,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText('laptop-A / laptop-B — six more tasks, split evenly.', {
    x: rx + 0.4, y: colY + 1.68, w: colW - 0.8, h: 0.35,
    fontFace: TEXT, fontSize: 13, color: BODY,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  miniMachine(s, { x: rx + 0.4, y: colY + 2.2, w: colW - 0.8, name: 'laptop-A', pct: 5, hot: false, tally: '3 tasks' });
  miniMachine(s, { x: rx + 0.4, y: colY + 2.72, w: colW - 0.8, name: 'laptop-B', pct: 8, hot: false, tally: '3 tasks' });

  s.addText(
    'Before the load rode on the poll, the recovered machine was passed over for another twenty seconds ' +
    'on a stale reading — all six of those tasks went the wrong way.',
    {
      x: M, y: 6.0, w: CW, h: 0.8,
      fontFace: TEXT, fontSize: 14, color: BODY,
      isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.25,
    },
  );
  s.addNotes('Real host, real agents, over loopback. The recovery half is what proved the poll needed to carry load.');
}

// ------------------------------------------------------------- 8. the bugs
{
  const s = lightSlide();
  kicker(s, 'Found by running it, not by reading it');
  title(s, 'Two faults only the real loop revealed');

  card(s, { x: M, y: TOP, w: CW, h: 1.9, fill: PAPER, line: HOT_SOFT });
  s.addText('A freshly enrolled agent announced itself at 100% load', {
    x: M + 0.4, y: TOP + 0.25, w: CW - 0.8, h: 0.38,
    fontFace: TEXT, fontSize: 16, bold: true, color: INK,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText(
    'The first sample lands microseconds after the sampler primes itself, so the tick window is a couple ' +
    'of ticks of quantised accounting and the ratio is noise — reliably 0% or 100%. The agent then declined ' +
    'the first work it was ever offered. It now reports unknown until it has an interval worth dividing.',
    {
      x: M + 0.4, y: TOP + 0.68, w: CW - 0.8, h: 1.0,
      fontFace: TEXT, fontSize: 13, color: BODY,
      isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.25,
    },
  );

  terminal(s, {
    x: M, y: TOP + 2.05, w: CW, size: 11,
    lines: [
      'before:  registered with host ... loadFactor=1      → over the ceiling, declining work',
      'after:   registered with host ... loadFactor=0.005  → takes work immediately',
    ],
  });

  card(s, { x: M, y: TOP + 3.1, w: CW, h: 1.3, fill: MIST });
  s.addText('The enrolment script wrote no load configuration at all', {
    x: M + 0.4, y: TOP + 3.3, w: CW - 0.8, h: 0.34,
    fontFace: TEXT, fontSize: 15, bold: true, color: INK,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText(
    'A machine enrolled today got none of this. It now takes --max-load and --concurrency, parsed with the ' +
    'same functions the agent uses, so a value setup accepts is one the agent will start with.',
    {
      x: M + 0.4, y: TOP + 3.68, w: CW - 0.8, h: 0.6,
      fontFace: TEXT, fontSize: 12.5, color: BODY,
      isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.2,
    },
  );
  s.addNotes('Both were invisible to unit tests and obvious the moment the real enrolment ran against a real host.');
}

// ------------------------------------------------------- 9. operator views
{
  const s = lightSlide();
  kicker(s, 'What you look at');
  title(s, 'Two commands that answer "is it spread?"');

  s.addText('node src/admin/run.js agents', {
    x: M, y: TOP + 0.1, w: CW, h: 0.32,
    fontFace: MONO, fontSize: 13, bold: true, color: COOL,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  terminal(s, {
    x: M, y: TOP + 0.5, w: CW,
    lines: [
      'NAME        VERSION  CAPABILITIES        RAM     FREE    HELD  CPU  RUN  IDLE',
      `laptop      ${VERSION}    echo,sysinfo        16075M  11448M  0M    8%   3    1s`,
      `alpha-host  ${VERSION}    alpha.coordination  32768M  20480M  0M    97%  0    2s`,
    ],
  });
  s.addText(
    'CPU is the share of that machine\'s cores in use; RUN is how many tasks it holds. A dash means ' +
    'the agent has not reported — read as unknown, never as idle.',
    {
      x: M, y: TOP + 1.6, w: CW, h: 0.7,
      fontFace: TEXT, fontSize: 13, color: BODY,
      isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.2,
    },
  );

  s.addText('node src/admin/run.js stats', {
    x: M, y: TOP + 2.6, w: CW, h: 0.32,
    fontFace: MONO, fontSize: 13, bold: true, color: COOL,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  terminal(s, {
    x: M, y: TOP + 3.0, w: CW,
    lines: [
      `Alpha ${VERSION} - 2 agent(s) attached`,
      '  load           busiest 97%, idlest 2%, 0 task(s) running',
      '  Work is not spread evenly - one machine is far busier than another.',
    ],
  });
  s.addText(
    'Far apart means the work is not being spread. Both high means the fleet really is full, and another ' +
    'machine is the only thing that helps.',
    {
      x: M, y: TOP + 4.15, w: CW, h: 0.7,
      fontFace: TEXT, fontSize: 13, color: BODY,
      isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.2,
    },
  );
  s.addNotes('busiest next to idlest is the whole point: far apart means unbalanced, both high means genuinely full.');
}

// ------------------------------------------------------------ 10. enrolment
{
  const s = lightSlide();
  kicker(s, 'Adding a machine');
  title(s, 'Enrolling a laptop as a peer');

  s.addText('1 — On the Alpha host, issue the machine its own key', {
    x: M, y: TOP, w: CW, h: 0.34,
    fontFace: TEXT, fontSize: 15, bold: true, color: INK,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  terminal(s, {
    x: M, y: TOP + 0.42, w: CW,
    lines: ['node src/admin/run.js issue-key --user <userId> --scopes agent --name laptop'],
  });

  s.addText('2 — On the laptop, one command does the rest', {
    x: M, y: TOP + 1.3, w: CW, h: 0.34,
    fontFace: TEXT, fontSize: 15, bold: true, color: INK,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  terminal(s, {
    x: M, y: TOP + 1.72, w: CW,
    lines: ['node scripts/setup-agent.mjs --host http://100.x.y.z:8787 --key alpha_key_... --concurrency 4'],
  });

  s.addText('It says what the machine will do before it does it', {
    x: M, y: TOP + 2.6, w: CW, h: 0.34,
    fontFace: TEXT, fontSize: 15, bold: true, color: INK,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  terminal(s, {
    x: M, y: TOP + 3.02, w: CW,
    lines: [
      '[1] Checking this machine',
      '  * 16075 MB of RAM, 15460 MB available right now',
      '  * 4 cores, running 4 tasks at a time',
      '      load 2% now; standing aside above 85%',
    ],
  });
  s.addNotes(
    'The script verifies the host is reachable and the key really is agent:connect, then attaches for a ' +
    'moment to prove the whole loop before reporting success.',
  );
}

// ------------------------------------------------------------- 11. version
{
  const s = lightSlide();
  kicker(s, 'Keeping the fleet in step');
  title(s, 'One version across every machine');

  body(s,
    'A checkout that was never pulled carries older handlers, older defaults and older bugs, and nothing ' +
    'in the wire format notices. Agents report their release so drift is a line of output rather than a puzzle.',
    { x: M, y: TOP, w: CW, h: 0.8, fontSize: 15 });

  terminal(s, {
    x: M, y: TOP + 0.95, w: CW,
    lines: [
      'NAME     VERSION    CAPABILITIES  RAM     FREE    HELD  CPU  RUN  IDLE',
      `tower    ${VERSION}      echo,sysinfo  32768M  21014M  0M    12%  1    2s`,
      `laptop   ${PRE_LOAD_VERSION} *    echo,sysinfo  16384M   9210M  0M    -    0    4s`,
      '',
      `* not the host's version (${VERSION}). Update laptop so every machine runs the same version.`,
    ],
  });

  card(s, { x: M, y: TOP + 2.5, w: CW, h: 1.5, fill: MIST });
  s.addText('The dash and the star are the same story told twice.', {
    x: M + 0.4, y: TOP + 2.7, w: CW - 0.8, h: 0.36,
    fontFace: TEXT, fontSize: 15, bold: true, color: INK,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText(
    `${PRE_LOAD_VERSION} predates load reporting, so that laptop cannot say how busy it is and the host ` +
    `ranks it as unknown. Getting both machines onto ${VERSION} is what turns it back into a number.`,
    {
      x: M + 0.4, y: TOP + 3.08, w: CW - 0.8, h: 0.75,
      fontFace: TEXT, fontSize: 13.5, color: BODY,
      isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.25,
    },
  );
  s.addNotes('Check parity from either machine with: node src/admin/run.js version');
}

// ------------------------------------------------------------- 12. closing
{
  const s = darkSlide();
  s.addText('Where it stands', {
    x: M, y: 1.5, w: 11.4, h: 0.5,
    fontFace: TEXT, fontSize: 13, bold: true, color: COOL, charSpacing: 2,
    isTextBox: true, margin: 0, valign: 'middle',
  });
  s.addText(`${VERSION} is ready for both machines`, {
    x: M, y: 1.95, w: 11.9, h: 0.9,
    fontFace: HEAD, fontSize: 38, bold: true, color: PAPER,
    isTextBox: true, margin: 0, valign: 'middle',
  });

  const items = [
    [`${TEST_COUNT} tests pass`, 'No new dependencies. Node standard library only, as before.'],
    ['Verified over loopback', 'Real coordinator, real agents, real enrolment — not mocks.'],
    ['Not yet verified on the tailnet', 'A cloud container cannot reach the Alpha host. Worth a run on the real pair, especially the Windows side where load comes entirely from sampled CPU ticks.'],
  ];
  items.forEach(([head, text], i) => {
    const y = 3.3 + i * 1.15;
    s.addShape(pres.ShapeType.ellipse, {
      x: M, y: y + 0.08, w: 0.16, h: 0.16,
      fill: { color: i === 2 ? HOT : COOL }, line: { color: i === 2 ? HOT : COOL, width: 0 },
    });
    s.addText(head, {
      x: M + 0.42, y, w: 11, h: 0.32,
      fontFace: TEXT, fontSize: 16, bold: true, color: PAPER,
      isTextBox: true, margin: 0, valign: 'middle',
    });
    s.addText(text, {
      x: M + 0.42, y: y + 0.34, w: 11, h: 0.62,
      fontFace: TEXT, fontSize: 13, color: '9FB0BE',
      isTextBox: true, margin: 0, valign: 'top', lineSpacingMultiple: 1.2,
    });
  });
  s.addNotes('The one honest gap: everything was proved over loopback, because this environment has no tailnet route.');
}

// A stable filename rather than a versioned one: the deck says which release
// it describes on its own slides, and a new file per bump is only churn.
pres.writeFile({ fileName: join(HERE, 'alpha-tunnel.pptx') })
  .then((f) => console.log('wrote', f));
