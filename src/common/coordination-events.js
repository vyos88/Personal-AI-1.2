/**
 * Merging two copies of Alpha's coordination log (`events.jsonl`).
 *
 * The log is written by `alpha_coordination_tunnel.ps1`: one JSON object per
 * line, append-only, each with a GUID `id` and an ISO `at`. When Worker1 is
 * away, a standby on the Host keeps a second copy and appends to that one
 * (Alpha's `WORKER1_FAILOVER_PLAN.md`). When Worker1 returns, the events only
 * the standby has are appended to Worker1's master copy. That is the whole
 * merge: because every event has its own id, nothing needs a judgment call.
 *
 * Three rules hold it together:
 *   - **The master is never rewritten.** Only lines it lacks are appended, so
 *     a merge cannot reorder or lose what Worker1 already had.
 *   - **A bad incoming line stops the merge before anything is written.** A
 *     half-transferred file must not be half-merged.
 *   - **Lines are copied as they are**, not re-serialized, so an event reads
 *     the same on both machines byte for byte (less a leading BOM).
 */

const BOM = '﻿';

/** Splits a JSONL text into non-blank lines, dropping a BOM wherever one sits. */
function lines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => (line.startsWith(BOM) ? line.slice(1) : line))
    .filter((line) => line.trim() !== '');
}

/**
 * Ids in the master. A master line that does not parse is left alone and only
 * counted: it is Worker1's own history, and fixing it is not this tool's job.
 */
export function masterIds(text) {
  const ids = new Set();
  let unreadable = 0;
  for (const line of lines(text)) {
    try {
      const event = JSON.parse(line);
      if (typeof event?.id === 'string' && event.id !== '') ids.add(event.id);
      else unreadable += 1;
    } catch {
      unreadable += 1;
    }
  }
  return { ids, unreadable };
}

/**
 * Reads the incoming copy strictly. Throws, naming the line, on anything that
 * is not a JSON object with a string `id` and a parseable `at`.
 */
export function readIncoming(text) {
  return lines(text).map((line, index) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`incoming line ${index + 1} is not valid JSON`);
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error(`incoming line ${index + 1} is not a JSON object`);
    }
    if (typeof event.id !== 'string' || event.id === '') {
      throw new Error(`incoming line ${index + 1} has no "id"`);
    }
    const at = Date.parse(event.at);
    if (Number.isNaN(at)) {
      throw new Error(`incoming line ${index + 1} (id ${event.id}) has no readable "at"`);
    }
    return { id: event.id, at, line, order: index };
  });
}

/**
 * Plans a merge without touching any file.
 *
 * Returns the lines to append, oldest first (ties keep the incoming file's
 * order), and what was skipped. An id that appears twice in the incoming copy
 * is appended once.
 */
export function planMerge(masterText, incomingText) {
  const { ids, unreadable } = masterIds(masterText);
  const incoming = readIncoming(incomingText);
  const seen = new Set();
  const missing = [];
  let alreadyPresent = 0;
  for (const event of incoming) {
    if (ids.has(event.id) || seen.has(event.id)) {
      alreadyPresent += 1;
      continue;
    }
    seen.add(event.id);
    missing.push(event);
  }
  missing.sort((a, b) => a.at - b.at || a.order - b.order);
  return {
    append: missing.map((event) => event.line),
    ids: missing.map((event) => event.id),
    alreadyPresent,
    masterUnreadable: unreadable,
  };
}

/**
 * The exact text to append to the master: the new lines, each ending in a
 * newline, preceded by one if the master does not already end with one (the
 * script writes with Add-Content, which does, but a hand-edited file may not).
 */
export function appendText(masterText, append) {
  if (append.length === 0) return '';
  const needsNewline = masterText.length > 0 && !masterText.endsWith('\n');
  return (needsNewline ? '\n' : '') + append.map((line) => `${line}\n`).join('');
}
