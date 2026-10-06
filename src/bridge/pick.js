/**
 * Which machine gets the next piece of work, shared by the bridges that spread
 * work over a pool (music, images). Each bridge pins its pick on the task as
 * `targetAgent`, because the result is a file that stays on the machine that
 * made it and has to be fetched back from exactly there.
 */

/**
 * One attached machine as a bridge may see it, or null for a machine that
 * does not offer `capability`. Only the name, idle time and work in hand: not
 * ids, addresses, owners, memory or the rest of its capabilities. `stale` is
 * passed on only when the coordinator reports it, rather than guessed here.
 */
export function describeAgent(agent, capability) {
  if (!Array.isArray(agent?.capabilities) || !agent.capabilities.includes(capability)) return null;
  return {
    name: agent.name ?? null,
    idleMs: Number.isFinite(agent.idleMs) ? agent.idleMs : null,
    inFlight: Number.isFinite(agent.inFlight) ? agent.inFlight : 0,
    ...(typeof agent.stale === 'boolean' ? { stale: agent.stale } : {}),
  };
}

/**
 * The least busy attached, non-stale machine offering `capability` within
 * `pool` (`'auto'` for any, or a list of names); ties go to the one idle
 * longest. Null when nobody in the pool is attached.
 */
export function pickMachine(agents, capability, pool) {
  const allowed = pool === 'auto' ? null : new Set(pool);
  const ready = (Array.isArray(agents) ? agents : [])
    .map((agent) => describeAgent(agent, capability))
    .filter((m) => m && m.name && m.stale !== true && (!allowed || allowed.has(m.name)));
  // Least work in hand first. A named pool lists machines in order of
  // preference, so equal load goes to the earlier one: the Host's RTX 3050
  // before Worker1's CPU ("host,worker1"). `auto` has no order, so the
  // machine idle longest wins the tie.
  const rank = (name) => (Array.isArray(pool) ? pool.indexOf(name) : 0);
  ready.sort((a, b) => a.inFlight - b.inFlight || rank(a.name) - rank(b.name) || (b.idleMs ?? 0) - (a.idleMs ?? 0));
  return ready[0]?.name ?? null;
}

/** "auto" or "a,b" -> a pool; one plain name -> null (that machine, always). */
export function parsePool(value) {
  const raw = String(value ?? '').trim();
  if (raw.toLowerCase() === 'auto') return 'auto';
  if (!raw.includes(',')) return null;
  const names = raw.split(',').map((n) => n.trim()).filter(Boolean);
  return names.length ? names : null;
}
