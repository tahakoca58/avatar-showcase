// Production Facility engine. Pure functions (no DOM) that turn the real run event log
// (tools/core/event-log.mjs) and the system model (/api/facility) into facility state.
// The stage graph mirrors docs/facility-architecture.md, i.e. the order of the code in
// producer-orchestrator.mjs, capability-executor.mjs, the adapters and provider clients.

const is = (type, where = () => true) => (event) => event.type === type && where(event);
const anyOf = (...matchers) => (event) => matchers.some((match) => match(event));
const notExecutePhase = (event) => event.phase !== "execute";
const FINAL_PROVIDER_STEPS = new Set(["compose", "stem_separation"]);

// Each stage: where it lives in the facility (zone), which real component it is, and
// which events prove that it started, finished or broke.
export const STAGES = [
  {
    id: "request", label: "Request received", concept: "Request Desk", component: "intake",
    zone: () => "intake",
    done: anyOf(is("agent.request_received"), is("prepare.started")),
  },
  {
    id: "producer", label: "Producer active", concept: "Producer Studio", component: "producer",
    zone: (ctx) => `studio:${ctx.producerId}`,
    done: anyOf(is("agent.profile_read"), is("prepare.started")),
  },
  {
    id: "prepare", label: "producer_prepare", concept: "Preparation Room", component: "prepare",
    zone: () => "prep",
    start: is("prepare.started"),
    done: anyOf(is("prepare.completed"), is("job.persisted")),
    fail: is("prepare.failed"),
  },
  {
    id: "knowledge", label: "Knowledge resolution", concept: "Producer Archive", component: "knowledge",
    zone: () => "archive",
    start: is("knowledge.catalog_loaded", notExecutePhase),
    done: is("knowledge.resolved", notExecutePhase),
  },
  {
    id: "job", label: "Job persisted", concept: "Production Case", component: "job",
    zone: () => "case",
    done: is("job.persisted"),
  },
  {
    id: "brief", label: "Creative brief", concept: "Production Blueprint", component: "brief",
    zone: () => "blueprint",
    done: anyOf(is("execute.started"), is("execute.awaiting_approval")),
    waiting: "LLM brief yazıyor",
  },
  {
    id: "approval", label: "Studio approval", concept: "Execution Gate", component: "approval",
    zone: () => "tower",
    applies: (ctx) => ctx.allEvents.some((e) => e.type.startsWith("execute.awaiting_approval") || e.type === "execute.approval_consumed"),
    start: is("execute.awaiting_approval"),
    done: is("execute.approval_consumed"),
    waiting: "Stüdyo onayı bekleniyor",
  },
  {
    id: "execute", label: "producer_execute", concept: "Control Tower · Execution Gate", component: "execute",
    zone: () => "tower",
    start: is("execute.started"),
    done: anyOf(is("job.running"), is("job.waiting_for_provider")),
    fail: anyOf(is("execute.rejected"), is("knowledge.changed")),
  },
  {
    id: "router", label: "Tool Router", concept: "Routing Switchyard", component: "router",
    zone: () => "switchyard",
    done: anyOf(is("router.capability_line"), is("router.selected")),
  },
  {
    id: "registry", label: "Provider Registry", concept: "Dispatch Board", component: "registry",
    zone: () => "dispatch",
    done: anyOf(is("registry.resolved", (e) => Boolean(e.selected)), is("router.selected")),
    awaiting: anyOf(is("router.no_provider"), is("registry.resolved", (e) => !e.selected)),
  },
  {
    id: "adapter_out", label: "Adapter · outbound", concept: "Translation Gate", component: "adapter",
    zone: (ctx) => `gate:${ctx.providerId}`,
    done: is("adapter.called"),
  },
  {
    id: "provider", label: "External provider", concept: "External Production Unit", component: "provider",
    zone: (ctx) => `unit:${ctx.unitId}`,
    start: is("adapter.called"),
    progress: (e) => e.type.startsWith("provider."),
    done: anyOf(
      is("provider.status", (e) => e.status === "COMPLETED"),
      is("provider.response", (e) => FINAL_PROVIDER_STEPS.has(e.step)),
      is("provider.response_validated"),
      is("provider.output_received"),
    ),
  },
  {
    id: "response", label: "Response validation", concept: "Translation Gate · inbound", component: "adapter",
    zone: (ctx) => `gate:${ctx.providerId}`,
    done: anyOf(is("provider.response_validated"), is("provider.output_received"), is("provider.response", (e) => FINAL_PROVIDER_STEPS.has(e.step))),
  },
  {
    id: "storage", label: "Local file saved", concept: "Output Vault · intake", component: "vault",
    zone: () => "vault",
    done: is("artifact.saved"),
  },
  {
    id: "adapter_in", label: "Artifact contract", concept: "Translation Gate · inbound", component: "adapter",
    zone: (ctx) => `gate:${ctx.providerId}`,
    // Runs logged before contract events existed only have adapter.returned.
    done: (e, ctx) => (e.type === "adapter.contract_validated" && e.ok) || (ctx.legacy && e.type === "adapter.returned" && e.ok),
    fail: anyOf(is("adapter.contract_rejected"), is("adapter.returned", (e) => !e.ok)),
  },
  {
    id: "normalize", label: "Artifact normalization", concept: "Control Tower", component: "execute",
    zone: () => "tower",
    done: anyOf(is("artifact.normalized"), is("job.completed")),
  },
  {
    id: "complete", label: "Completed", concept: "Output Vault", component: "vault",
    zone: () => "vault",
    done: is("job.completed"),
    fail: is("job.failed"),
  },
];

export const PREP_CHECKS = [
  { id: "identity", label: "Producer identity locked", done: is("prepare.started") },
  { id: "workflow", label: "Workflow locked", done: is("prepare.route_resolved") },
  { id: "capability", label: "Capability locked", done: is("prepare.route_resolved") },
  { id: "catalog", label: "Knowledge catalog loaded", done: is("knowledge.catalog_loaded", notExecutePhase) },
  { id: "primary", label: "Primary genre resolved", done: is("knowledge.primary_resolved", notExecutePhase) },
  { id: "secondary", label: "Secondary genres resolved", done: is("knowledge.resolved", notExecutePhase) },
  { id: "lineage", label: "Knowledge lineage selected", done: is("knowledge.resolved", notExecutePhase) },
  { id: "fingerprint", label: "Knowledge fingerprint created", done: is("knowledge.fingerprinted") },
  { id: "job", label: "Persistent job created", done: is("job.persisted") },
  { id: "context", label: "brief_context returned", done: is("prepare.completed") },
];

export const GATE_CHECKS = [
  { id: "brief", label: "Creative brief present", done: is("execute.started") },
  { id: "authentic", label: "Job authenticity", done: is("execute.job_loaded"), fail: is("execute.rejected", (e) => e.check === "job_authenticity") },
  { id: "state", label: "Job state eligible", done: is("execute.state_checked", (e) => e.eligible), fail: is("execute.rejected", (e) => e.check === "job_state" || (!e.check && e.status)) },
  { id: "integrity", label: "Knowledge fingerprint integrity", done: is("knowledge.verified"), fail: is("knowledge.changed") },
  { id: "prompt", label: "Final prompt composed", done: is("prompt.composed"), na: (ctx) => ["STEM_SEPARATION", "DAW_CONTROL"].includes(ctx.capability) },
  { id: "authorized", label: "Execution authorized", done: is("job.running"), fail: is("job.waiting_for_provider") },
];

// Observable provider-side steps per external unit kind; anything else is "not exposed".
export const UNIT_STEPS = {
  runpod: [
    { id: "submitted", label: "Request submitted · /run", done: is("provider.submitted") },
    { id: "queued", label: "In queue", done: anyOf(is("provider.submitted", (e) => e.status === "IN_QUEUE"), is("provider.status", (e) => e.status === "IN_QUEUE")) },
    { id: "running", label: "Running on GPU", done: is("provider.status", (e) => e.status === "IN_PROGRESS") },
    { id: "completed", label: "Completed · /status", done: is("provider.status", (e) => e.status === "COMPLETED") },
    { id: "validated", label: "WAV validated (schema · base64 · bytes · RIFF · sha256)", done: anyOf(is("provider.response_validated"), is("provider.output_received")), inbound: true },
  ],
  elevenlabs: [
    { id: "plan_request", label: "Composition plan request", done: is("provider.request", (e) => e.step === "composition_plan"), optional: true },
    { id: "plan_response", label: "Composition plan received", done: is("provider.response", (e) => e.step === "composition_plan"), optional: true },
    { id: "request", label: "Generation request", done: is("provider.request", (e) => e.step !== "composition_plan") },
    { id: "response", label: "Audio received", done: is("provider.response", (e) => e.step !== "composition_plan"), inbound: true },
  ],
};

export const FAILURE_TYPES = new Set([
  "job.failed", "prepare.failed", "execute.rejected", "knowledge.changed", "adapter.contract_rejected",
]);

const isFailure = (e) => FAILURE_TYPES.has(e.type) || (e.type === "adapter.returned" && !e.ok);
const RETRY_TYPES = new Set(["prepare.started", "execute.started"]);

// The failure that still stands: a later prepare/execute attempt means the agent recovered
// from it (e.g. it retried producer_prepare with a genre the producer's catalog allows).
export function activeFailure(events) {
  let failure = null;
  for (const event of events) {
    if (isFailure(event)) failure = event;
    else if (failure && RETRY_TYPES.has(event.type)) failure = null;
  }
  return failure;
}

// Each producer_prepare call is one attempt; failed attempts stay visible in the run.
export function prepareAttempts(events) {
  const attempts = [];
  for (const event of events) {
    if (event.type === "prepare.started") attempts.push({ started: event, events: [event] });
    else if (attempts.length && !event.type.startsWith("execute.") && !event.type.startsWith("agent.")) attempts.at(-1).events.push(event);
  }
  return attempts.map((attempt) => {
    const failed = attempt.events.find((e) => e.type === "prepare.failed");
    const persisted = attempt.events.find((e) => e.type === "job.persisted");
    return {
      at: attempt.started.at,
      primaryGenre: attempt.started.primaryGenre,
      secondaryGenres: attempt.started.secondaryGenres ?? [],
      outcome: persisted ? "completed" : failed ? "failed" : "running",
      error: failed ? shortError(failed.error) : null,
      jobId: persisted?.jobId ?? null,
      events: attempt.events,
    };
  });
}

export function shortError(error) {
  // The resolver's "unknown genre" error lists every alias; the first sentence is the point.
  return String(error ?? "").split(" Available ids/aliases")[0].slice(0, 300);
}

// ---------- Grouping ----------

export function groupRuns(events) {
  const jobByRun = new Map();
  const turnByRun = new Map();
  for (const event of events) {
    if ((event.type === "job.persisted" || event.type === "agent.job_linked") && event.runId && event.jobId && !jobByRun.has(event.runId)) {
      jobByRun.set(event.runId, event.jobId);
    }
    // MCP events carry the web agent turn that triggered them (AVATAR_AGENT_TURN).
    if (event.agentTurn && event.runId) turnByRun.set(event.runId, event.agentTurn);
  }
  const runs = new Map();
  for (const event of events) {
    const turn = turnByRun.get(event.runId) ?? event.agentTurn;
    const key = event.jobId
      ?? jobByRun.get(event.runId)
      ?? (turn ? jobByRun.get(turn) ?? `run:${turn}` : null)
      ?? (event.runId ? `run:${event.runId}` : null);
    if (!key) continue;
    if (!runs.has(key)) runs.set(key, { key, events: [] });
    runs.get(key).events.push(event);
  }
  return [...runs.values()]
    .map((run) => {
      run.events.sort((a, b) => a.at.localeCompare(b.at));
      return summarizeRun(run);
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function firstValue(events, key) {
  for (const event of events) if (event[key] !== undefined && event[key] !== null) return event[key];
  return null;
}

export function runOutcome(events) {
  const types = new Set(events.map((e) => e.type));
  if (types.has("job.completed")) return "completed";
  if (activeFailure(events)) return "failed";
  if (types.has("job.waiting_for_provider") || types.has("router.no_provider")) return "awaiting_provider";
  const lastGate = events.filter((e) => e.type === "execute.awaiting_approval" || e.type === "execute.approval_consumed" || e.type === "execute.started").at(-1);
  if (lastGate?.type === "execute.awaiting_approval") return "awaiting_approval";
  if (types.has("execute.started")) return "running";
  if (types.has("job.persisted")) return "prepared";
  if (types.has("prepare.started")) return "preparing";
  return "conversation";
}

function summarizeRun(run) {
  const events = run.events;
  const persisted = events.find((e) => e.type === "job.persisted");
  return {
    ...run,
    jobId: persisted?.jobId ?? events.find((e) => e.type === "agent.job_linked")?.jobId ?? firstValue(events, "jobId"),
    producerId: firstValue(events, "producerId"),
    source: firstValue(events, "source"),
    runtime: firstValue(events, "runtime"),
    request: events.find((e) => e.type === "agent.request_received" && !e.approval)?.text
      ?? events.find((e) => e.type === "prepare.started")?.userRequest
      ?? null,
    startedAt: events[0].at,
    lastAt: events.at(-1).at,
    outcome: runOutcome(events),
    attempts: events.filter((e) => e.type === "prepare.started").length,
  };
}

// ---------- Run state ----------

function contextFor(run, events, model) {
  const pick = (type, key) => events.filter((e) => e.type === type && e[key]).at(-1)?.[key];
  const capability = pick("prepare.route_resolved", "capability") ?? pick("job.persisted", "capability")
    ?? pick("execute.job_loaded", "capability") ?? pick("router.capability_line", "capability") ?? pick("router.selected", "capability") ?? null;
  const workflowId = pick("prepare.route_resolved", "workflowId") ?? pick("job.persisted", "workflowId")
    ?? pick("execute.job_loaded", "workflowId") ?? pick("prepare.started", "workflowId") ?? null;
  const providerId = pick("registry.resolved", "selected") ?? pick("router.dispatched", "providerId")
    ?? pick("router.selected", "providerId") ?? pick("adapter.called", "providerId") ?? null;
  const provider = model?.providers?.find((p) => p.providerId === providerId) ?? null;
  return {
    producerId: run.producerId,
    capability,
    workflowId,
    providerId,
    unitId: provider?.unit?.id ?? (providerId ? `unknown-${providerId}` : null),
    unitKind: provider?.unit?.kind ?? null,
    allEvents: run.events,
    legacy: !run.events.some((e) => e.type === "prepare.route_resolved" || e.type === "router.capability_line"),
  };
}

// Walks a checklist in order. The step where the phase broke gets ✕; steps after it were
// never reached. finished: the phase is over, so a missing step was simply not recorded
// (runs logged before that step had an event).
function checklist(checks, events, ctx, { failure = null, finished = false, reached = true } = {}) {
  let blocked = false;
  let failureShown = false;
  return checks.map((check) => {
    if (check.na?.(ctx)) return { ...check, state: "na" };
    if (!reached) return { ...check, state: "pending" };
    const done = events.find(check.done);
    if (done) return { ...check, state: "done", at: done.at, event: done };
    const failed = check.fail ? events.find(check.fail) : null;
    if (failed || (failure && !failureShown)) {
      blocked = true;
      failureShown = true;
      const reason = failed ?? failure;
      return { ...check, state: "failed", at: reason.at, event: reason, error: shortError(reason.error ?? reason.check ?? reason.status) };
    }
    if (failureShown || blocked) return { ...check, state: "pending" };
    if (finished) return { ...check, state: "unrecorded" };
    blocked = true;
    return { ...check, state: "next" };
  });
}

// What the archive actually loaded in the latest attempt: the primary lineage and each
// secondary query, resolved, skipped as duplicate, or rejected (with the resolver's reason).
function knowledgeSummary(attempt, failure) {
  if (!attempt) return null;
  const events = attempt.events;
  const primary = events.find((e) => e.type === "knowledge.primary_resolved" && e.phase !== "execute") ?? null;
  const resolved = events.filter((e) => e.type === "knowledge.secondary_resolved" && e.phase !== "execute");
  const rejected = failure?.type === "prepare.failed" && events.includes(failure) ? shortError(failure.error) : null;
  let rejectedShown = false;
  const secondary = attempt.secondaryGenres.map((query, index) => {
    const hit = resolved[index];
    if (hit) return { query, id: hit.id, lineage: hit.lineage, state: hit.duplicate ? "duplicate" : "resolved" };
    if (rejected && primary && !rejectedShown) {
      rejectedShown = true;
      return { query, state: "rejected", error: rejected };
    }
    return { query, state: "pending" };
  });
  return {
    catalog: events.find((e) => e.type === "knowledge.catalog_loaded" && e.phase !== "execute") ?? null,
    primaryQuery: attempt.primaryGenre,
    primary: primary ? { id: primary.id, lineage: primary.lineage, classification: primary.classification } : null,
    primaryRejected: rejected && !primary ? rejected : null,
    secondary,
    loaded: (primary ? 1 : 0) + secondary.filter((s) => s.state === "resolved").length,
  };
}

export function runState(run, model, cursor = run.events.length) {
  const events = run.events.slice(0, cursor);
  const ctx = contextFor(run, run.events, model);
  const outcome = runOutcome(events);
  const terminal = ["completed", "failed", "awaiting_provider"].includes(outcome);
  const failure = activeFailure(events);
  const attempts = prepareAttempts(events);
  const attempt = attempts.at(-1) ?? null;
  const attemptEvents = attempt?.events ?? [];
  const applicable = STAGES.filter((stage) => !stage.applies || stage.applies(ctx));
  const doneEvents = applicable.map((stage) => events.find((e) => stage.done(e, ctx)) ?? null);
  const lastDone = doneEvents.reduce((max, event, index) => (event ? index : max), -1);
  // A prepare failure inside knowledge resolution (unknown genre, genre outside the producer's
  // catalog) originates in the archive, not in the preparation room itself.
  const knowledgeOrigin = failure?.type === "prepare.failed"
    && attemptEvents.some((e) => e.type === "knowledge.catalog_loaded" && e.phase !== "execute")
    && !attemptEvents.some((e) => e.type === "knowledge.resolved" && e.phase !== "execute");

  let previousAt = run.events[0]?.at ?? null;
  let assigned = false;
  const stages = applicable.map((stage, index) => {
    const zone = stage.zone(ctx);
    const done = doneEvents[index];
    const started = stage.start ? events.find(stage.start) : null;
    const related = events.filter((e) => e === done || e === started || (stage.progress && stage.progress(e)) || (stage.fail && stage.fail(e)));
    if (done) {
      const row = { ...stage, zone, state: "completed", startedAt: started?.at ?? previousAt, at: done.at, related, event: done };
      row.duration = row.startedAt ? new Date(done.at) - new Date(row.startedAt) : null;
      previousAt = done.at;
      return row;
    }
    const failedHere = failure && ((stage.fail && stage.fail(failure)) || (stage.id === "knowledge" && knowledgeOrigin)) ? failure : null;
    // One failure point per run; the archive may share it with the room it serves.
    if (failedHere && (!assigned || stage.id === "knowledge")) {
      assigned = true;
      return { ...stage, zone, state: "failed", at: failedHere.at, related: [...related, failedHere], event: failedHere, error: shortError(failedHere.error ?? failedHere.errorCode ?? failedHere.check ?? failedHere.status) };
    }
    if (stage.awaiting) {
      const waiting = events.find(stage.awaiting);
      if (waiting && !assigned) {
        assigned = true;
        return { ...stage, zone, state: "awaiting_provider", at: waiting.at, related, event: waiting };
      }
    }
    if (index < lastDone) return { ...stage, zone, state: "skipped", related };
    if (!assigned && failure) {
      assigned = true;
      return { ...stage, zone, state: "failed", at: failure.at, related: [...related, failure], event: failure, error: shortError(failure.error ?? failure.errorCode ?? failure.check) };
    }
    if (!assigned && !terminal) {
      assigned = true;
      const progress = stage.progress ? events.filter(stage.progress).at(-1) : null;
      const waitingState = stage.id === "approval" || (stage.id === "brief" && outcome === "prepared");
      return { ...stage, zone, state: waitingState ? "waiting" : "active", since: started?.at ?? previousAt, related, progress };
    }
    return { ...stage, zone, state: "pending", related };
  });

  // Where it broke is the most specific failed stage (e.g. the archive rather than the room).
  const failedStages = stages.filter((s) => s.state === "failed");
  const current = failedStages.at(-1)
    ?? stages.find((s) => ["active", "waiting", "awaiting_provider"].includes(s.state))
    ?? (outcome === "completed" ? stages.at(-1) : null);
  const completed = stages.filter((s) => s.state === "completed");
  const next = stages.filter((s) => s.state === "pending");
  const executeIndex = events.findLastIndex((e) => e.type === "execute.started" || e.type === "execute.awaiting_approval");
  const gateEvents = executeIndex >= 0 ? events.slice(executeIndex) : [];

  return {
    run,
    cursor,
    total: run.events.length,
    events,
    ctx,
    outcome,
    failure,
    failurePhase: !failure ? null : failure.type === "prepare.failed" ? (knowledgeOrigin ? "knowledge" : "prepare")
      : failure.type === "execute.rejected" || failure.type === "knowledge.changed" ? "execute" : "provider",
    attempts,
    stages,
    current,
    completed,
    next,
    prepChecks: checklist(PREP_CHECKS, attemptEvents, ctx, {
      failure: failure?.type === "prepare.failed" && attemptEvents.includes(failure) ? failure : null,
      finished: attemptEvents.some((e) => e.type === "job.persisted"),
      reached: Boolean(attempt),
    }),
    gateChecks: checklist(GATE_CHECKS, gateEvents, ctx, {
      failure: failure && gateEvents.includes(failure) && failure.type !== "job.failed" && !(failure.type === "adapter.returned") ? failure : null,
      finished: terminal && gateEvents.length > 0,
      reached: gateEvents.length > 0,
    }),
    knowledge: knowledgeSummary(attempt, failure),
    unitSteps: unitSteps(ctx, events),
    zones: zoneStates(stages, ctx, model),
    request: run.request,
    brief: events.filter((e) => e.type === "execute.started" && e.creativeBrief).at(-1)?.creativeBrief
      ?? events.filter((e) => e.type === "execute.awaiting_approval" && e.creativeBrief).at(-1)?.creativeBrief ?? null,
    lineage: attemptEvents.find((e) => e.type === "knowledge.resolved" && e.phase !== "execute") ?? null,
    registryDecision: events.find((e) => e.type === "registry.resolved") ?? null,
  };
}

function unitSteps(ctx, events) {
  const steps = UNIT_STEPS[ctx.unitKind];
  if (!steps) return null;
  const rows = steps.map((step) => {
    const done = events.find(step.done);
    return { ...step, state: done ? "done" : "pending", at: done?.at ?? null, event: done ?? null };
  });
  const usesPlan = rows.some((r) => r.optional && r.state === "done");
  return rows.filter((r) => !r.optional || usesPlan);
}

// Zone states for the whole facility map, not just the run's own path.
function zoneStates(stages, ctx, model) {
  const zones = {};
  const rank = { idle: 0, pending: 0, skipped: 1, completed: 2, waiting: 3, awaiting_provider: 3, active: 4, failed: 5 };
  const set = (zone, state) => {
    if (!zone) return;
    if ((rank[state] ?? 0) >= (rank[zones[zone]] ?? 0)) zones[zone] = state;
  };
  for (const stage of stages) {
    if (stage.state === "pending" || stage.state === "skipped") continue;
    set(stage.zone, stage.state);
  }
  // The producer's studio is where the brief is written, so it lights with the blueprint.
  const brief = stages.find((s) => s.id === "brief");
  if (brief && ["active", "waiting"].includes(brief.state)) set(`studio:${ctx.producerId}`, "active");
  for (const capability of model?.capabilities ?? []) {
    const id = `line:${capability.id}`;
    if (capability.id === ctx.capability) {
      const route = stages.find((s) => s.id === "router");
      const end = stages.at(-1);
      const registry = stages.find((s) => s.id === "registry");
      zones[id] = registry?.state === "awaiting_provider" ? "awaiting_provider"
        : end?.state === "completed" ? "completed"
          : stages.some((s) => s.state === "failed") && route?.state === "completed" ? "failed"
            : route?.state === "completed" ? "active" : capability.connected ? "idle" : "unavailable";
    } else {
      zones[id] = capability.connected ? "idle" : "unavailable";
    }
  }
  return zones;
}

// ---------- Text ----------

const PROVIDER_STATUS_TR = { IN_QUEUE: "kuyrukta", IN_PROGRESS: "GPU'da çalışıyor", COMPLETED: "bitti", FAILED: "başarısız", CANCELLED: "iptal", TIMED_OUT: "zaman aşımı" };

export function sourceLabel(source, runtime) {
  if (source === "web-agent") return `LLM · web stüdyo${runtime ? ` (${runtime === "claude" ? "Claude" : "Codex"})` : ""}`;
  if (source === "mcp") return "LLM · MCP (Codex/Claude desktop)";
  if (source === "web") return "Test tezgâhı";
  return "Bilinmiyor";
}

export function describeEvent(e) {
  switch (e.type) {
    case "agent.request_received": return e.approval ? "Stüdyo onay mesajı agent'a iletildi" : `İstek alındı: "${String(e.text ?? "").slice(0, 80)}"`;
    case "agent.profile_read": return `Producer profili okundu · ${e.path ?? e.command ?? ""}`;
    case "agent.tool_called": return `Agent aracı çağırdı · ${e.server}.${e.tool}`;
    case "agent.job_linked": return `Konuşma job'a bağlandı (${e.via})`;
    case "agent.message": return `Agent mesajı · ${e.chars} karakter`;
    case "agent.turn_completed": return `Agent turu bitti · ${e.state}`;
    case "approval.granted": return "Stüdyoda üretim onayı verildi";
    case "prepare.started": return `producer_prepare · ${e.producerId} · "${e.primaryGenre}"`;
    case "prepare.route_resolved": return `Rota: ${e.workflowId} → ${e.capability} (${e.capabilitySource === "explicit" ? "açık seçim" : "workflow'un ilk adımı"})`;
    case "knowledge.catalog_loaded": return `Katalog yüklendi · ${e.packCount} paket${e.phase === "execute" ? " (doğrulama)" : ""}`;
    case "knowledge.primary_resolved": return `Primary: "${e.query}" → ${e.lineage?.join(" › ")}`;
    case "knowledge.secondary_resolved": return `Secondary: "${e.query}" → ${e.id}${e.duplicate ? " (tekrar, atlandı)" : ""}`;
    case "knowledge.resolved": return `Lineage seçildi · ${e.primary?.lineage?.join(" › ")}`;
    case "knowledge.fingerprinted": return `Bilgi parmak izi · ${e.fingerprint}`;
    case "job.persisted": return `Job kaydedildi · ${e.jobPath}`;
    case "prepare.completed": return `brief_context döndü · ${e.briefContextPacks?.join(", ")}`;
    case "prepare.failed": return `Hazırlık başarısız: ${e.error}`;
    case "execute.awaiting_approval": return "producer_execute stüdyo onayı bekliyor";
    case "execute.approval_consumed": return "Onay tüketildi (tek kullanımlık)";
    case "execute.started": return `producer_execute · brief ${e.briefChars} karakter`;
    case "execute.job_loaded": return `Job doğrulandı · şema v${e.schemaVersion} · ${e.status}`;
    case "execute.state_checked": return `Durum kontrolü · ${e.status} · ${e.eligible ? "uygun" : "uygun değil"}`;
    case "execute.rejected": return `Execute reddedildi · ${e.check ?? e.status}${e.error ? ` · ${e.error}` : ""}`;
    case "knowledge.verified": return `Parmak izi eşleşti · ${e.fingerprint}`;
    case "knowledge.changed": return "Bilgi job'dan sonra değişmiş";
    case "prompt.composed": return `Final prompt · ${e.promptChars}/${e.limit} karakter · ${e.includedGuidanceCount} satır`;
    case "router.capability_line": return `Tool Router · ${e.capability} hattı`;
    case "registry.resolved": return `Registry · ${e.selected ?? "provider yok"} (${(e.candidates ?? []).length} aday)`;
    case "router.dispatched": return `Dispatch → ${e.displayName}`;
    case "router.selected": return `Tool Router → ${e.displayName}`;
    case "router.no_provider": return `${e.capability} için provider yok`;
    case "job.running": return "Job durumu: running";
    case "job.waiting_for_provider": return "Job provider bekliyor";
    case "adapter.called": return `Adapter · ${e.providerId}`;
    case "provider.submitted": return `Runpod /run · ${PROVIDER_STATUS_TR[e.status] ?? e.status}`;
    case "provider.status": return `Runpod · ${PROVIDER_STATUS_TR[e.status] ?? e.status}${e.elapsedMs ? ` · ${Math.round(e.elapsedMs / 1000)} sn` : ""}`;
    case "provider.request": return `ElevenLabs isteği · ${e.step}`;
    case "provider.response": return `ElevenLabs cevabı · ${e.step}`;
    case "provider.response_validated": return `Cevap doğrulandı · ${(e.checks ?? []).join(" · ")}`;
    case "provider.output_received": return "Worker çıktısı alındı";
    case "artifact.saved": return `Dosya kaydedildi · ${e.path}`;
    case "adapter.returned": return `Adapter döndü · ${e.ok ? "başarılı" : `hata ${e.errorCode ?? ""}`}`;
    case "adapter.contract_validated": return "Artifact kontratı doğrulandı";
    case "adapter.contract_rejected": return `Kontrat ihlali · ${e.error}`;
    case "artifact.normalized": return `Sonuç normalize edildi · ${(e.fields ?? []).length} alan`;
    case "job.completed": return "Job tamamlandı";
    case "job.failed": return `Job başarısız: ${e.error}`;
    default: return e.type;
  }
}

export function detectBpm(text) {
  const match = String(text ?? "").match(/(\d{2,3})\s*BPM/i);
  return match ? Number(match[1]) : null;
}
