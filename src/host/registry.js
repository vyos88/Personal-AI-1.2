import {
  newId,
  AGENT_STALE_MS,
  MEMORY_REPORT_STALE_MS,
  LOAD_REPORT_STALE_MS,
  SUPERSEDED_MEMORY_MS,
  UNKNOWN_LOAD_FACTOR,
  MB,
} from '../common/protocol.js';
import { ALPHA_VERSION } from '../common/version.js';
import { createLogger } from '../common/log.js';

const log = createLogger('host:registry');

/**
 * Tracks which agents are attached, what each of them can run, and how much
 * RAM each is currently lending the host.
 *
 * The registry doubles as the queue's admission controller: before a task with
 * a `minMemoryMB` requirement is handed to an agent, the registry checks the
 * agent's latest memory report and holds that much against it for the life of
 * the lease. Without the hold, three 4 GB tasks would all be placed on the
 * same 8 GB laptop in the same instant, because none of them would have
 * started consuming memory yet when the next one was matched.
 *
 * One registration per worker, too. Every agent dials out, so a worker that
 * crashed and came back is indistinguishable from a new one on the wire: it
 * registers, gets a new id, and its dead registration goes on lending the same
 * machine's memory until the stale sweep. Agents therefore report an instance
 * id (see src/agent/identity.js), and a registration that repeats one replaces
 * the earlier registration rather than joining it. Reporting one is optional —
 * an agent that does not is simply never recognised as a returning worker.
 *
 * It also ranks agents, which is what stops two laptops from being driven into
 * the ground together. Free RAM is a poor proxy for "can take more work": a
 * machine pinned at 100% CPU by its owner's own build still reports plenty of
 * memory. So `rank()` orders candidates by how much work they are already
 * holding, then by how loaded they last said they were, and the queue hands
 * the task to the best of them instead of to whoever asked first.
 */
export class AgentRegistry {
  #agents = new Map();
  // Registrations dropped because the same worker registered again, kept just
  // long enough to tell the superseded process why its id stopped working.
  #superseded = new Map();

  constructor({
    staleMs = AGENT_STALE_MS,
    supersededMemoryMs = SUPERSEDED_MEMORY_MS,
    now = () => Date.now(),
  } = {}) {
    this.staleMs = staleMs;
    this.supersededMemoryMs = supersededMemoryMs;
    this.now = now;
  }

  register({
    name,
    capabilities,
    instanceId = null,
    memory = null,
    load = null,
    version = null,
    remoteAddress,
    principal = null,
    userId = null,
    keyId = null,
  }) {
    const agent = {
      id: newId('agent'),
      name,
      capabilities,
      // Which worker this is, across restarts of it. One registration is kept
      // per instance — see #supersede.
      instanceId,
      // Which release this machine is running, or null from an agent too old
      // to report one. Never used for placement — only so drift is visible.
      version,
      remoteAddress: remoteAddress ?? null,
      // Which credential attached this agent, so its owner can be identified
      // and so one user's credential cannot drive another user's worker.
      principal,
      userId,
      // The specific key, not just its owner. Two machines sharing one key
      // work, but cannot be revoked or retired apart, so it is worth saying.
      keyId,
      registeredAt: this.now(),
      lastSeenAt: this.now(),
      tasksCompleted: 0,
      tasksFailed: 0,
      // Latest report from the agent, plus what is already promised to tasks
      // it is holding right now.
      memory: null,
      memoryReportedAt: null,
      reservedBytes: 0,
      // What the agent last reported offerable at the moment its current run
      // of reservations began. Reservations are settled against this, so a
      // task's memory stops being held twice once the machine's own report
      // shows it has actually been taken. Zero when nothing is reserved.
      reservedAgainstBytes: 0,
      // How busy this machine said it was, and how many leases it is holding
      // right now. The second needs no report and never goes stale, which is
      // why it outranks the first.
      load: null,
      loadReportedAt: null,
      inFlight: 0,
    };
    // Before this machine is counted, retire whatever it left behind. A worker
    // that crashed or was killed never got to deregister, so without this its
    // dead registration goes on offering the machine's RAM and covering its
    // capabilities until the stale sweep — the fleet reads as two workers, and
    // `stats` as twice the memory that exists.
    const previous = this.#findLiveInstance(agent);
    this.#agents.set(agent.id, agent);
    if (previous) this.#supersede(previous, agent);
    this.#warnAboutCollisions(agent);
    if (memory) this.reportMemory(agent.id, memory);
    if (load) this.reportLoad(agent.id, load);
    log.info('agent registered', {
      agentId: agent.id,
      name,
      instanceId,
      capabilities,
      principal,
      version,
      offerableMB: memory ? Math.round(memory.offerableBytes / MB) : null,
      loadFactor: load?.loadFactor ?? null,
    });
    // The agent cleared PROTOCOL_VERSION, so this is drift, not incompatibility:
    // attach it and make the mismatch loud rather than turning the worker away.
    if (version && version !== ALPHA_VERSION) {
      log.warn('agent is not on the host\'s version of Alpha', {
        agentId: agent.id,
        name,
        agentVersion: version,
        hostVersion: ALPHA_VERSION,
      });
    }
    return agent;
  }

  /**
   * The registration this one replaces, if any.
   *
   * Matched on the instance id *and* the owner: one user's credential must not
   * be able to evict another user's worker, which is the same rule the agent
   * plane enforces when a request tries to drive a registration it does not
   * own. An agent that reports no instance id matches nothing — it cannot be
   * recognised, so it is treated as a new worker, exactly as before.
   */
  #findLiveInstance(agent) {
    if (!agent.instanceId) return null;
    for (const existing of this.#agents.values()) {
      if (existing.id === agent.id) continue;
      if (existing.instanceId !== agent.instanceId) continue;
      if ((existing.userId ?? null) !== (agent.userId ?? null)) continue;
      return existing;
    }
    return null;
  }

  /**
   * Retires `previous` in favour of `agent`, and remembers that it did.
   *
   * The newest process wins, and the superseded one is told to stand down
   * rather than left to discover a 410 and register itself straight back in.
   * That direction is what makes this terminate: two agent processes started
   * on one machine converge on one survivor instead of evicting each other
   * forever, and a restarted worker takes over from its own corpse
   * immediately rather than waiting out AGENT_STALE_MS.
   *
   * Tasks the retired registration was holding are not touched. Its leases
   * expire and the sweeper requeues them, which is the same path a dead agent
   * has always taken; requeueing here instead would hand a task to a second
   * machine while the process that has it is still aborting.
   */
  #supersede(previous, agent) {
    this.#agents.delete(previous.id);
    this.#forgetStaleSupersessions();
    this.#superseded.set(previous.id, {
      at: this.now(),
      byAgentId: agent.id,
      instanceId: previous.instanceId,
      name: previous.name,
    });
    log.warn('agent registration superseded by a newer process on the same machine', {
      superseded: previous.id,
      by: agent.id,
      name: agent.name,
      instanceId: agent.instanceId,
      heldTasks: previous.inFlight,
      idleMs: this.now() - previous.lastSeenAt,
    });
  }

  /**
   * Why this registration stopped existing, or null if the host simply does
   * not know the id. The two deserve different answers: an agent the host has
   * forgotten should register again, while one a newer process took over from
   * should stop asking.
   */
  supersededBy(agentId) {
    this.#forgetStaleSupersessions();
    return this.#superseded.get(agentId) ?? null;
  }

  #forgetStaleSupersessions() {
    const cutoff = this.now() - this.supersededMemoryMs;
    for (const [id, record] of this.#superseded) {
      if (record.at < cutoff) this.#superseded.delete(id);
    }
  }

  /**
   * Two things that are legal, work, and are worth one line in the log each,
   * because both are invisible from `alpha-admin agents` alone and both are
   * usually a copied configuration rather than a decision.
   */
  #warnAboutCollisions(agent) {
    for (const existing of this.#agents.values()) {
      if (existing.id === agent.id) continue;
      // Two machines under one name. Placement does not care, but every
      // operator-facing surface does: two identical rows, and log lines that
      // cannot be told apart.
      if (existing.name === agent.name) {
        log.warn('two machines are attached under the same name', {
          name: agent.name,
          agents: [existing.id, agent.id],
          hint: 'set ALPHA_AGENT_NAME on one of them so the fleet can be read',
        });
      }
      // One key on two machines. Revocation and expiry are per key, so this
      // cannot retire one machine without retiring the other.
      if (agent.keyId && existing.keyId === agent.keyId) {
        log.warn('one agent key is in use by two machines', {
          keyId: agent.keyId,
          agents: [existing.id, agent.id],
          hint: 'issue each machine its own key so it can be revoked on its own',
        });
      }
    }
  }

  /** Records a fresh memory reading. Sent on registration and every heartbeat. */
  reportMemory(agentId, memory) {
    const agent = this.#agents.get(agentId);
    if (!agent || !memory) return null;
    agent.memory = memory;
    agent.memoryReportedAt = this.now();
    return agent;
  }

  /** Records a fresh CPU reading. Sent alongside memory on every heartbeat. */
  reportLoad(agentId, load) {
    const agent = this.#agents.get(agentId);
    if (!agent || !load) return null;
    agent.load = load;
    agent.loadReportedAt = this.now();
    return agent;
  }

  /**
   * How loaded this agent last said it was, or null when that is unknown.
   *
   * Unknown covers three cases that all deserve the same answer: an agent too
   * old to report load, one whose platform could not measure it, and one whose
   * last report has gone stale. Guessing zero for any of them would make the
   * silent machine the most attractive target in the fleet.
   */
  loadFactor(agentId) {
    const agent = typeof agentId === 'string' ? this.#agents.get(agentId) : agentId;
    if (!agent?.load || agent.load.loadFactor === null) return null;
    if (this.now() - agent.loadReportedAt > LOAD_REPORT_STALE_MS) return null;
    return agent.load.loadFactor;
  }

  /**
   * What the agent itself last said it could lend. A missing or stale report
   * counts as zero — an unknown amount of RAM is not a licence to place work.
   */
  reportedOfferableBytes(agentId) {
    const agent = typeof agentId === 'string' ? this.#agents.get(agentId) : agentId;
    if (!agent?.memory) return 0;
    if (this.now() - agent.memoryReportedAt > MEMORY_REPORT_STALE_MS) return 0;
    return agent.memory.offerableBytes;
  }

  /**
   * The part of this agent's reservations that its own reports have not caught
   * up with yet, and which therefore still has to be held back by hand.
   *
   * A reservation exists to cover one specific window: between a task being
   * placed and the memory it wants actually being taken. Inside that window the
   * agent's report still shows the RAM as free, so without the hold a second
   * task would be placed against the same bytes. Once the task allocates,
   * though, the drop is in the report — and subtracting the reservation from it
   * as well charged the machine twice for the same gigabytes, which quietly
   * took a working laptop out of the running for the rest of the lease.
   *
   * So credit the drop the agent has actually reported since these reservations
   * began against what they promised, and hold back only the remainder. A
   * report that has not moved still withholds the lot, which is exactly the old
   * behaviour in the window the hold is for.
   *
   * This is a deliberate trade, not a free win. The host cannot see *why* the
   * machine's memory moved, so a drop the owner's own build caused settles the
   * reservation just as readily as the task taking what it asked for. An 8 GB
   * agent holding an unstarted 4 GB task, whose owner then eats 4 GB, reports 4
   * GB free and is credited in full — so a second 4 GB task can be placed
   * against memory the first one is still going to take. Holding for the whole
   * lease refused that, at the cost of the far commoner fault of a working
   * laptop looking empty until its lease ran out. The overcommit needs
   * unrelated consumption of at least `minMemoryMB` *and* a second
   * memory-tagged task, both inside the same window; the machine looking empty
   * happened on every single memory-tagged task. Hence this way round.
   *
   * Closing it properly needs the agent to be able to refuse — it is the only
   * party that knows what its RAM is actually doing — and it cannot today,
   * because the task it is handed does not carry `minMemoryMB` at all.
   */
  unmaterializedBytes(agentId) {
    const agent = typeof agentId === 'string' ? this.#agents.get(agentId) : agentId;
    if (!agent?.reservedBytes) return 0;
    const observedDrop = Math.max(0, agent.reservedAgainstBytes - this.reportedOfferableBytes(agent));
    return Math.max(0, agent.reservedBytes - observedDrop);
  }

  /**
   * Bytes this agent can still be given work against: what it last offered,
   * less whatever its in-flight tasks have promised but not yet taken.
   */
  offerableBytes(agentId) {
    const agent = typeof agentId === 'string' ? this.#agents.get(agentId) : agentId;
    if (!agent) return 0;
    return Math.max(0, this.reportedOfferableBytes(agent) - this.unmaterializedBytes(agent));
  }

  /** Any authenticated call from an agent counts as a sign of life. */
  touch(agentId) {
    const agent = this.#agents.get(agentId);
    if (!agent) return null;
    agent.lastSeenAt = this.now();
    return agent;
  }

  recordOutcome(agentId, succeeded) {
    const agent = this.#agents.get(agentId);
    if (!agent) return;
    if (succeeded) agent.tasksCompleted += 1;
    else agent.tasksFailed += 1;
  }

  // ------------------------------------------------------- admission control
  // The three methods the queue calls to place memory-hungry work. Tasks
  // without a requirement are admitted by every agent and hold nothing.

  canAdmit(agentId, task) {
    // A task that names a machine is offered to that machine and to nothing
    // else. Checked first because it is exact and free, where everything below
    // is arithmetic on reports that age.
    if (!this.#matchesTarget(agentId, task)) return false;
    const needed = requiredBytes(task);
    if (needed === 0) return true;
    return this.offerableBytes(agentId) >= needed;
  }

  /**
   * Whether this agent is the machine the task asked for, or the task asked
   * for no machine in particular.
   *
   * Matched on the name, which may belong to more than one machine — two
   * laptops set up from one copied configuration is the usual way that
   * happens. That is deliberate: naming `laptop` when two machines answer to
   * it means "either of those", and ranking picks between them, which is a
   * better answer than refusing the work.
   */
  #matchesTarget(agentId, task) {
    const target = task?.targetAgent;
    if (!target) return true;
    const agent = typeof agentId === 'string' ? this.#agents.get(agentId) : agentId;
    return agent?.name === target;
  }

  admit(agentId, task) {
    const agent = this.#agents.get(agentId);
    if (!agent) return;
    // Counted for every task, memory requirement or not. This is the only
    // placement signal that is exact and immediate — a task handed over a
    // millisecond ago has not moved a memory report or a load average yet, and
    // without it a burst of work all lands on one machine before any of it
    // shows up in a reading.
    agent.inFlight += 1;
    const needed = requiredBytes(task);
    if (needed === 0) return;
    // Anchor this run of reservations to the reading they are being made
    // against, so the drop that follows can be credited to them. Only the
    // first one sets it: re-anchoring on a later admission would forget the
    // drop the earlier tasks have already accounted for and hold their memory
    // a second time.
    if (agent.reservedBytes === 0) {
      agent.reservedAgainstBytes = this.reportedOfferableBytes(agent);
    }
    agent.reservedBytes += needed;
  }

  release(agentId, task) {
    const agent = this.#agents.get(agentId);
    if (!agent) return;
    agent.inFlight = Math.max(0, agent.inFlight - 1);
    const needed = requiredBytes(task);
    if (needed === 0) return;
    agent.reservedBytes = Math.max(0, agent.reservedBytes - needed);
    // Nothing outstanding, so there is nothing left to settle: the agent's own
    // report is the whole truth again until the next task is placed.
    if (agent.reservedBytes === 0) agent.reservedAgainstBytes = 0;
  }

  /**
   * How poor a target this agent is, lower being better. The queue places each
   * task on the lowest-ranked agent that can run it.
   *
   * Work in hand dominates: the load contribution is scaled below 1 so that an
   * agent holding a task always ranks worse than an idle one, however quiet it
   * claims its CPUs are. Within the same number of leases, the less loaded
   * machine wins — which is the whole point, and is what keeps the second
   * laptop from being handed work simply because it asked first.
   */
  rank(agentId) {
    const agent = typeof agentId === 'string' ? this.#agents.get(agentId) : agentId;
    if (!agent) return Number.POSITIVE_INFINITY;
    const load = this.loadFactor(agent) ?? UNKNOWN_LOAD_FACTOR;
    return agent.inFlight + Math.min(load, 1) * 0.999;
  }

  deregister(agentId) {
    const agent = this.#agents.get(agentId);
    if (agent) {
      this.#agents.delete(agentId);
      log.info('agent deregistered', { agentId, name: agent.name });
    }
    return Boolean(agent);
  }

  get(agentId) {
    return this.#agents.get(agentId) ?? null;
  }

  /**
   * Whether this registration is still live. The queue asks before handing a
   * task to a parked poll, because a poll can outlast the registration behind
   * it — pruned as stale, or superseded by a newer process on the machine.
   */
  knows(agentId) {
    return this.#agents.has(agentId);
  }

  /** Drops agents that have gone quiet; returns the ids removed. */
  prune() {
    this.#forgetStaleSupersessions();
    const cutoff = this.now() - this.staleMs;
    const dropped = [];
    for (const [id, agent] of this.#agents) {
      if (agent.lastSeenAt < cutoff) {
        this.#agents.delete(id);
        dropped.push(id);
        log.warn('agent pruned as stale', { agentId: id, name: agent.name });
      }
    }
    return dropped;
  }

  list() {
    const now = this.now();
    // `keyId` stays behind: it is recorded so the host can say when two
    // machines are attached on one credential, and `agents:read` is a weaker
    // scope than the `keys:read` that exists for looking at credentials.
    return [...this.#agents.values()].map(({ keyId, ...agent }) => ({
      ...agent,
      idleMs: now - agent.lastSeenAt,
      availableBytes: this.offerableBytes(agent),
      // Of `reservedBytes`, the part the agent's own reports have not shown
      // being taken yet — the only part still being held back by hand.
      unmaterializedBytes: this.unmaterializedBytes(agent),
      // Resolved rather than raw, so a reader sees the figure placement
      // actually used — null where the report is missing or stale.
      loadFactor: this.loadFactor(agent),
      rank: this.rank(agent),
    }));
  }

  /**
   * Agents that could take this task right now, by capability and by RAM,
   * best target first.
   */
  candidatesFor(task) {
    return [...this.#agents.values()]
      .filter((agent) => agent.capabilities.includes(task.type) && this.canAdmit(agent.id, task))
      .sort((a, b) => this.rank(a) - this.rank(b));
  }

  /** Total memory attached agents are currently lending, less what is spoken for. */
  offeredBytes() {
    let total = 0;
    for (const agent of this.#agents.values()) total += this.offerableBytes(agent);
    return total;
  }

  /**
   * Whether anything attached would run this type — restricted to one machine
   * by name when the caller names one, so a task that asks for `alpha.render`
   * on the host is not told "somebody runs that" on the strength of a laptop
   * that does.
   */
  coversType(type, { agentName = null } = {}) {
    for (const agent of this.#agents.values()) {
      if (agentName && agent.name !== agentName) continue;
      if (agent.capabilities.includes(type)) return true;
    }
    return false;
  }

  /** Whether a machine is attached under this name. */
  hasAgentNamed(name) {
    for (const agent of this.#agents.values()) {
      if (agent.name === name) return true;
    }
    return false;
  }

  /** Task types at least one attached agent is willing to run. */
  coveredCapabilities() {
    const covered = new Set();
    for (const agent of this.#agents.values()) {
      for (const capability of agent.capabilities) covered.add(capability);
    }
    return [...covered].sort();
  }
}

function requiredBytes(task) {
  return Math.max(0, Math.floor((task?.minMemoryMB ?? 0) * MB));
}
