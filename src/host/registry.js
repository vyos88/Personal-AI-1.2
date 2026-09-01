import { newId, AGENT_STALE_MS, MEMORY_REPORT_STALE_MS, MB } from '../common/protocol.js';
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
 */
export class AgentRegistry {
  #agents = new Map();

  constructor({ staleMs = AGENT_STALE_MS, now = () => Date.now() } = {}) {
    this.staleMs = staleMs;
    this.now = now;
  }

  register({ name, capabilities, memory = null, remoteAddress, principal = null, userId = null }) {
    const agent = {
      id: newId('agent'),
      name,
      capabilities,
      remoteAddress: remoteAddress ?? null,
      // Which credential attached this agent, so its owner can be identified
      // and so one user's credential cannot drive another user's worker.
      principal,
      userId,
      registeredAt: this.now(),
      lastSeenAt: this.now(),
      tasksCompleted: 0,
      tasksFailed: 0,
      // Latest report from the agent, plus what is already promised to tasks
      // it is holding right now.
      memory: null,
      memoryReportedAt: null,
      reservedBytes: 0,
    };
    this.#agents.set(agent.id, agent);
    if (memory) this.reportMemory(agent.id, memory);
    log.info('agent registered', {
      agentId: agent.id,
      name,
      capabilities,
      principal,
      offerableMB: memory ? Math.round(memory.offerableBytes / MB) : null,
    });
    return agent;
  }

  /** Records a fresh memory reading. Sent on registration and every heartbeat. */
  reportMemory(agentId, memory) {
    const agent = this.#agents.get(agentId);
    if (!agent || !memory) return null;
    agent.memory = memory;
    agent.memoryReportedAt = this.now();
    return agent;
  }

  /**
   * Bytes this agent can still be given work against: what it last offered,
   * minus what its in-flight tasks already claimed. A missing or stale report
   * counts as zero — an unknown amount of RAM is not a licence to place work.
   */
  offerableBytes(agentId) {
    const agent = typeof agentId === 'string' ? this.#agents.get(agentId) : agentId;
    if (!agent?.memory) return 0;
    if (this.now() - agent.memoryReportedAt > MEMORY_REPORT_STALE_MS) return 0;
    return Math.max(0, agent.memory.offerableBytes - agent.reservedBytes);
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
    const needed = requiredBytes(task);
    if (needed === 0) return true;
    return this.offerableBytes(agentId) >= needed;
  }

  admit(agentId, task) {
    const needed = requiredBytes(task);
    const agent = this.#agents.get(agentId);
    if (needed === 0 || !agent) return;
    agent.reservedBytes += needed;
  }

  release(agentId, task) {
    const needed = requiredBytes(task);
    const agent = this.#agents.get(agentId);
    if (needed === 0 || !agent) return;
    agent.reservedBytes = Math.max(0, agent.reservedBytes - needed);
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

  /** Drops agents that have gone quiet; returns the ids removed. */
  prune() {
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
    return [...this.#agents.values()].map((agent) => ({
      ...agent,
      idleMs: now - agent.lastSeenAt,
      availableBytes: this.offerableBytes(agent),
    }));
  }

  /** Agents that could take this task right now, by capability and by RAM. */
  candidatesFor(task) {
    return [...this.#agents.values()].filter(
      (agent) => agent.capabilities.includes(task.type) && this.canAdmit(agent.id, task),
    );
  }

  /** Total memory attached agents are currently lending, less what is spoken for. */
  offeredBytes() {
    let total = 0;
    for (const agent of this.#agents.values()) total += this.offerableBytes(agent);
    return total;
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
