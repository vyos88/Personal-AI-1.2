// A snapshot shaped like the one Alpha's Agent Manager writes
// (alpha.agent-manager.status.v3), including the PowerShell quirk where a
// one-element array is written as a bare object.
export function managerSnapshot({ generatedAt = new Date().toISOString(), ...overrides } = {}) {
  return {
    schema: 'alpha.agent-manager.status.v3',
    generated_at: generatedAt,
    backend: { status: 'healthy', ready: true },
    worker_count: 59,
    fleet_counts: { resident_workers: 3, registered_model_agents: 12, runtime_daemons: 9, runtime_tasks: 16 },
    attention_count: 0,
    verified_active_count: 1,
    external_gate_count: 0,
    resource_protected_count: 1,
    accuracy: { scored_agents: 29, strong_count: 13, improve_count: 16, average_score: 78.6 },
    devices: [
      {
        name: 'Main Laptop VyoS', hostname: 'DESKTOP-41HPLCN', kind: 'laptop', role: 'alpha-main',
        online: true, local: true, ips: ['100.69.243.25', 'fd7a::1'], agent_count: 22,
        assignment_state: 'verified-local', cpu_percent: 54.2, memory_percent: 71,
      },
      {
        name: "Jack's Laptop", hostname: 'LAPTOP-GJ8DFMLK', kind: 'laptop', role: 'side-worker',
        online: true, local: false, ips: ['100.93.104.24'], agent_count: 1,
        assignment_state: 'verified-worker', heartbeat_age_seconds: 12, cpu_percent: 20, memory_percent: 93,
      },
    ],
    workers: [
      { worker_id: 'manager', state: 'SUPERVISING', pid: 19800, process_state: 'alive', latest_evidence: null },
      {
        worker_id: 'alpha-local', state: 'RECEIPT-FRESH', pid: 12616, process_state: 'alive',
        accuracy: { grade: 'A', score: 100 }, latest_evidence: 'Receipt verified',
      },
      {
        worker_id: 'model:alpha-chat-qc-c63eb759', state: 'ATTENTION', pid: null, process_state: 'registry-only',
        accuracy: { grade: 'A', score: 100 }, latest_evidence: 'Registry record',
      },
    ],
    // One recommendation: PowerShell writes it as an object, not a list.
    assistant: {
      recommendations: {
        priority: 'HIGH', agent_id: 'model:alpha-chat-qc-c63eb759',
        title: "Clear 'incomplete' reported by model:alpha-chat-qc-c63eb759",
        suggested_action: 'It says: HTTPException: 502: Local LLM request failed',
      },
    },
    workflow_tunnel: { state: 'awaiting-evolution-receipt', handoffs: [] },
    active_claims_v2: { records: 53, current: 0, expired: 0, abandoned: 53, superseded: 0 },
    continuity: { status: 'linked' },
    campaign_agents: { id: 'apps-management', last_tick_status: 'error' },
    // What the summary must leave behind: the file runs to megabytes.
    reliability_audit: { blob: 'x'.repeat(50_000) },
    ...overrides,
  };
}
