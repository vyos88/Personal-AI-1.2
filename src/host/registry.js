import { newId, AGENT_STALE_MS } from '../common/protocol.js';
import { createLogger } from '../common/log.js';

const log = createLogger('host:registry');

/** Tracks which agents are attached and what each of them can run. */
export class AgentRegistry {
  #agents = new Map();

  constructor({ staleMs = AGENT_STALE_MS, now = () => Date.now() } = {}) {
    this.staleMs = staleMs;
    this.now = now;
  }

  register({ name, capabilities, remoteAddress }) {
    const agent = {
      id: newId('agent'),
      name,
      capabilities,
      remoteAddress: remoteAddress ?? null,
      registeredAt: this.now(),
      lastSeenAt: this.now(),
      tasksCompleted: 0,
      tasksFailed: 0,
    };
    this.#agents.set(agent.id, agent);
    log.info('agent registered', { agentId: agent.id, name, capabilities });
    return agent;
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
    }));
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
