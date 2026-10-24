// AVATARS 2 // PRODUCTION FACILITY. Renders the real system model (/api/facility) and the
// real run event log (/api/trace + SSE "trace") as a production facility. All stage logic
// lives in facility-engine.js; this file only draws it.

import { GATE_CHECKS, groupRuns, runState, describeEvent, sourceLabel, detectBpm } from "./facility-engine.js";

const STATE_TEXT = {
  idle: "idle",
  active: "active",
  waiting: "waiting",
  completed: "completed",
  failed: "failed",
  unavailable: "unavailable",
  awaiting_provider: "awaiting provider",
  skipped: "not used",
  pending: "pending",
};

const OUTCOME_TEXT = {
  completed: "Completed",
  failed: "Failed",
  running: "Executing",
  preparing: "Preparing",
  prepared: "Prepared · not executed yet",
  awaiting_approval: "Awaiting studio approval",
  awaiting_provider: "Awaiting provider",
  conversation: "Conversation only",
};

const ACTIVE_OUTCOMES = new Set(["running", "preparing", "prepared", "awaiting_approval"]);
const META_KEYS = new Set(["at", "type", "source", "runId", "jobId", "producerId"]);

// Which runtime events belong to each real component, for the reality layer.
const COMPONENT_EVENTS = {
  intake: (t) => t === "agent.request_received" || t === "prepare.started",
  producer: (t) => t.startsWith("agent.") || t === "prepare.route_resolved",
  prepare: (t) => t.startsWith("prepare.") || t === "knowledge.fingerprinted" || t === "job.persisted",
  knowledge: (t) => t.startsWith("knowledge."),
  job: (t) => t.startsWith("job."),
  brief: (t) => t === "execute.started" || t === "execute.awaiting_approval",
  approval: (t) => t === "approval.granted" || t === "execute.awaiting_approval" || t === "execute.approval_consumed",
  execute: (t) => t.startsWith("execute.") || ["knowledge.verified", "knowledge.changed", "prompt.composed", "job.running", "artifact.normalized", "job.completed", "job.failed"].includes(t),
  router: (t) => t.startsWith("router."),
  registry: (t) => t === "registry.resolved" || t === "router.no_provider",
  adapter: (t) => t.startsWith("adapter.") || t === "provider.response_validated",
  provider: (t) => t.startsWith("provider."),
  vault: (t) => t.startsWith("artifact.") || t === "job.completed",
  workflow: (t) => t === "prepare.route_resolved",
  capability: (t) => t === "router.capability_line",
};

export function createFacility(ctx) {
  const { el, fill, api } = ctx;
  const fs = {
    model: null,
    events: [],
    loaded: false,
    follow: true,
    selectedKey: null,
    cursor: null,
    replayTimer: null,
    inspect: null,
    seen: new Set(),
    jobs: new Map(),
    flashUntil: 0,
    historyOpen: false,
  };
  let root = null;
  let plan = null;
  let caseToken = null;
  let resizeBound = false;

  // ---------- data ----------

  async function load() {
    const [model, trace] = await Promise.all([api("/api/facility"), fs.loaded ? null : api("/api/trace?limit=5000")]);
    fs.model = model;
    if (trace) {
      fs.events = trace.events;
      fs.loaded = true;
      for (const run of groupRuns(fs.events)) fs.seen.add(run.key);
    }
  }

  function allRuns() {
    return groupRuns(fs.events);
  }

  function selectedRun(runs) {
    if (fs.follow || !fs.selectedKey) return runs[0] ?? null;
    return runs.find((run) => run.key === fs.selectedKey) ?? runs[0] ?? null;
  }

  async function jobDetail(jobId, lastAt) {
    if (!jobId) return null;
    const cached = fs.jobs.get(jobId);
    if (cached && cached.lastAt === lastAt) return cached.job;
    try {
      const job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
      fs.jobs.set(jobId, { lastAt, job });
      return job;
    } catch {
      fs.jobs.set(jobId, { lastAt, job: null });
      return null;
    }
  }

  function component(id) {
    return fs.model?.components.find((c) => c.id === id) ?? null;
  }

  // ---------- small pieces ----------

  const stateClass = (state) => `st-${state ?? "idle"}`;
  const mark = (state) => ({ done: "✓", completed: "✓", failed: "✕", next: "●", active: "●", waiting: "◐", na: "–", unrecorded: "–", pending: "○" }[state] ?? "○");

  function elapsed(since, rs) {
    if (!since) return null;
    if (fs.cursor !== null && rs) return el("span", {}, ctx.fmtDuration(new Date(rs.events.at(-1).at) - new Date(since)));
    return el("span", { "data-since": since }, "");
  }

  // Job status as of the cursor, from events (the job file only holds the final state).
  function statusAt(rs) {
    if (!rs) return null;
    if (rs.outcome === "completed") return "completed";
    if (rs.outcome === "failed") return "failed";
    if (rs.outcome === "awaiting_provider") return "waiting_for_provider";
    if (rs.events.some((e) => e.type === "job.running")) return "running";
    if (rs.events.some((e) => e.type === "job.persisted")) return "prepared";
    return null;
  }

  function label(text, extra) {
    return el("div", { class: "z-label" }, el("span", {}, text), extra ? el("span", { class: "z-real mono" }, extra) : null);
  }

  function stateTag(state) {
    return el("span", { class: `z-state ${stateClass(state)}` }, STATE_TEXT[state] ?? state);
  }

  function zone(id, area, componentId, state, header, ...content) {
    return el("section", {
      class: `zone ${area ? `a-${area}` : ""} ${stateClass(state)}`,
      "data-zone": id,
      tabindex: "0",
      role: "button",
      "aria-label": `${header.concept} — ${header.real}: ${STATE_TEXT[state] ?? state}`,
      onclick: (event) => {
        event.stopPropagation();
        openInspector(componentId, id);
      },
      onkeydown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openInspector(componentId, id);
        }
      },
    },
      el("header", { class: "z-head" },
        el("div", {}, el("div", { class: "z-concept" }, header.concept), el("div", { class: "z-real mono" }, header.real)),
        stateTag(state)),
      content);
  }

  function checklistView(items) {
    return el("ol", { class: "checklist" }, items.map((item) =>
      el("li", { class: `ck-${item.state}` }, el("span", { class: "ck-mark", "aria-hidden": "true" }, mark(item.state)),
        el("span", {}, item.label, item.state === "failed" && item.error ? el("span", { class: "ck-error" }, item.error) : null),
        item.state === "na" ? el("span", { class: "faint" }, "n/a") : item.state === "unrecorded" ? el("span", { class: "faint" }, "no record") : null)));
  }

  function kv(pairs) {
    return el("dl", { class: "fkv" }, pairs.filter(Boolean).flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v ?? el("span", { class: "faint" }, "Not available"))]));
  }

  // ---------- zones ----------

  function intakeZone(rs) {
    const run = rs?.run;
    const state = rs?.zones.intake ?? "idle";
    return zone("intake", "intake", "intake", state, { concept: "Request Desk", real: "agent turn · MCP call" },
      run
        ? [
            kv([["Source", sourceLabel(run.source, run.runtime)], ["Received", ctx.fmtClockTime(run.startedAt)]]),
            run.request ? el("p", { class: "z-quote" }, `“${run.request.slice(0, 160)}${run.request.length > 160 ? "…" : ""}”`) : el("p", { class: "faint" }, "Request text not exposed for this run."),
          ]
        : el("p", { class: "faint" }, "Waiting for a production brief."));
  }

  function studiosZone(rs) {
    const route = rs?.events.find((e) => e.type === "prepare.route_resolved");
    const prepare = rs?.events.find((e) => e.type === "prepare.started");
    return el("div", { class: "a-studios studios" }, fs.model.producers.map((producer) => {
      const id = `studio:${producer.id}`;
      const state = rs?.zones[id] ?? "idle";
      const mine = rs?.ctx.producerId === producer.id;
      const theme = ctx.producerTheme(producer.id);
      return el("section", {
        class: `zone f-studio ${stateClass(state)}`,
        "data-zone": id,
        style: { "--accent": theme.accent, "--accent-glow": theme.glow },
        tabindex: "0",
        role: "button",
        "aria-label": `${producer.name} studio: ${STATE_TEXT[state]}`,
        onclick: (event) => { event.stopPropagation(); openInspector("producer", id); },
      },
        el("header", { class: "z-head" },
          el("div", {}, el("div", { class: "z-concept" }, `${producer.name} Studio`), el("div", { class: "z-real mono" }, `producers/${producer.id}.md`)),
          stateTag(state)),
        el("div", { class: "studio-role" }, "Creative Director · ", producer.specialty),
        mine && (route || prepare)
          ? el("div", { class: "decisions" },
              el("div", { class: "z-sub" }, "Producer decisions"),
              kv([
                ["Workflow", route?.workflowId ?? prepare?.workflowId],
                ["Capability", route?.capability ?? prepare?.capability ?? null],
                ["Genre query", prepare?.primaryGenre],
                ["Provider", el("span", { class: "faint" }, "not a producer decision → registry")],
              ]))
          : el("div", { class: "faint studio-catalog" }, `${producer.catalog.packCount} packs · ${producer.catalog.reviewStatus}`),
        el("a", { class: "studio-link", href: `#/studio/${producer.id}`, onclick: (event) => event.stopPropagation() }, "Open studio"));
    }));
  }

  function prepZone(rs) {
    const state = rs?.zones.prep ?? "idle";
    const attempts = rs?.attempts ?? [];
    return zone("prep", "prep", "prepare", state, { concept: "Preparation Room", real: "producer_prepare" },
      attempts.length > 1
        ? el("ol", { class: "attempts" }, attempts.map((attempt, index) => el("li", { class: `at-${attempt.outcome}` },
            el("span", { class: "ck-mark" }, attempt.outcome === "completed" ? "✓" : attempt.outcome === "failed" ? "✕" : "●"),
            el("span", {}, `Attempt ${index + 1} · ${attempt.primaryGenre}${attempt.secondaryGenres.length ? ` + ${attempt.secondaryGenres.join(", ")}` : ""}`,
              attempt.error ? el("span", { class: "ck-error" }, attempt.error) : null))))
        : null,
      rs ? checklistView(rs.prepChecks) : el("p", { class: "faint" }, "Idle."),
      el("div", { class: "flags" },
        el("span", {}, "Provider call: ", el("b", {}, "NONE")),
        el("span", {}, "Generation: ", el("b", {}, "OFF")),
        el("span", {}, "Credits used: ", el("b", {}, "0"))));
  }

  function archiveZone(rs) {
    const state = rs?.zones.archive ?? "idle";
    const producer = fs.model.producers.find((p) => p.id === rs?.ctx.producerId);
    const k = rs?.knowledge;
    const lineage = k?.primary?.lineage ?? null;
    const mark2 = { resolved: "✓", duplicate: "↺", rejected: "✕", pending: "○" };
    return zone("archive", "archive", "knowledge", state, { concept: "Producer Archive", real: "knowledge resolver" },
      producer ? kv([
        ["Catalog", `${producer.id} · ${producer.catalog.contentVersion}`],
        ["Loaded", k ? `${k.loaded} of ${producer.catalog.packCount} packs (resolved lineage only)` : `0 of ${producer.catalog.packCount}`],
      ]) : null,
      k?.primaryRejected ? el("p", { class: "ck-failed-line" }, `✕ "${k.primaryQuery}" · ${k.primaryRejected}`) : null,
      lineage
        ? el("ol", { class: "lineage" }, lineage.map((id, index) => el("li", { class: index === lineage.length - 1 ? "leaf" : "" }, id.toUpperCase().replaceAll("-", " "))))
        : el("p", { class: "faint" }, rs ? (k?.primaryRejected ? "No lineage loaded." : "Resolving…") : "Idle."),
      k?.secondary.length
        ? el("div", { class: "accents" },
            el("span", { class: "z-sub" }, "Secondary accents"),
            el("ol", { class: "checklist" }, k.secondary.map((item) => el("li", { class: item.state === "rejected" ? "ck-failed" : item.state === "resolved" ? "ck-done" : "ck-pending" },
              el("span", { class: "ck-mark" }, mark2[item.state]),
              el("span", {}, item.id ?? item.query, item.state === "duplicate" ? " (duplicate, skipped)" : "",
                item.state === "rejected" ? el("span", { class: "ck-error" }, item.error) : null)))))
        : null);
  }

  function caseZone(rs, job) {
    const state = rs?.zones.case ?? "idle";
    const persisted = rs?.events.find((e) => e.type === "job.persisted");
    return zone("case", "case", "job", state, { concept: "Production Case", real: "persisted job" },
      persisted || job
        ? kv([
            ["Job", el("span", { class: "mono" }, rs.run.jobId)],
            ["Schema", job?.schemaVersion ? `v${job.schemaVersion}` : persisted?.schemaVersion ? `v${persisted.schemaVersion}` : null],
            ["Workflow", job?.workflowId ?? persisted?.workflowId],
            ["Capability", job?.capability ?? persisted?.capability],
            ["Genre", job?.primaryGenre ?? persisted?.primaryGenre],
            ["Secondary", (job?.secondaryGenres ?? persisted?.secondaryGenres ?? []).join(", ") || "—"],
            ["Fingerprint", el("span", { class: "mono" }, (job?.knowledgeFingerprint ?? persisted?.fingerprint ?? "").slice(0, 12) || null)],
            ["Created", job?.createdAt ? ctx.fmtClockTime(job.createdAt) : persisted ? ctx.fmtClockTime(persisted.at) : null],
            ["Status", statusAt(rs) ?? job?.status ?? persisted?.status],
          ])
        : el("p", { class: "faint" }, "No production case yet."));
  }

  function blueprintZone(rs, job) {
    const state = rs?.zones.blueprint ?? "idle";
    const brief = rs?.brief ?? (fs.cursor === null ? job?.creativeBrief : null) ?? null;
    const defaults = job?.briefContext?.primary?.defaults ?? {};
    const briefStage = rs?.stages.find((s) => s.id === "brief");
    const bpm = detectBpm(brief);
    return zone("blueprint", "blueprint", "brief", state, { concept: "Production Blueprint", real: "creative brief → producer_execute" },
      el("div", { class: "stamp" }, "PROVIDER NEUTRAL"),
      brief
        ? el("p", { class: "blueprint-text" }, brief.length > 420 ? `${brief.slice(0, 420)}…` : brief)
        : el("p", { class: "faint" }, briefStage && ["active", "waiting"].includes(briefStage.state)
          ? ["The producer is writing the brief · ", elapsed(briefStage.since, rs)]
          : "No brief yet."),
      job || bpm
        ? kv([
            ["Tempo (brief)", bpm ? `${bpm} BPM` : null],
            job?.capability === "MUSIC_GENERATION" ? ["Length / mode", `${(job.musicLengthMs ?? 0) / 1000}s · ${job.generationMode} · ${job.forceInstrumental ? "instrumental" : "vocals allowed"}`] : null,
            job?.capability === "SAMPLE_GENERATION" ? ["Sample length", job.durationSeconds ? `${job.durationSeconds}s` : null] : null,
            job?.negativePrompt ? ["Avoid", job.negativePrompt] : null,
            Object.keys(defaults).length ? ["Knowledge defaults", `${Object.keys(defaults).length} fields (${Object.keys(defaults).join(", ")}) · inspect`] : null,
          ].filter((row) => row && row[1]))
        : null);
  }

  function towerZone(rs) {
    const state = rs?.zones.tower ?? "idle";
    const lifecycle = ["prepared", "running", "completed"];
    // A failure before job persistence never reached the tower; only later failures are its own.
    const jobExists = rs?.events.some((e) => e.type === "job.persisted" || e.type === "execute.job_loaded");
    const jobStatus = rs?.outcome === "completed" ? "completed"
      : rs?.outcome === "failed" && jobExists ? "failed"
        : rs?.outcome === "awaiting_provider" ? "waiting_for_provider"
          : rs?.events.some((e) => e.type === "job.running") ? "running"
            : rs?.events.some((e) => e.type === "job.persisted") ? "prepared" : null;
    const approval = rs?.stages.find((s) => s.id === "approval");
    const authorized = rs?.events.some((e) => e.type === "job.running");
    return zone("tower", "tower", "execute", state, { concept: "Control Tower · Execution Gate", real: "producer_execute" },
      el("div", { class: "lifecycle" }, [...lifecycle, jobStatus === "failed" ? "failed" : jobStatus === "waiting_for_provider" ? "waiting_for_provider" : null].filter(Boolean).map((s) =>
        el("span", { class: s === jobStatus ? "on" : "" }, s.replaceAll("_", " ")))),
      rs?.outcome === "failed" && !jobExists ? el("p", { class: "z-note faint" }, `Not reached · the run stopped in ${rs.failurePhase === "knowledge" ? "the Producer Archive" : "the Preparation Room"} before a job existed.`) : null,
      approval ? el("div", { class: `approval-line ${stateClass(approval.state)}` }, approval.state === "completed" ? "Studio approval consumed ✓" : approval.state === "waiting" ? "Awaiting studio approval ◐" : `Studio approval · ${STATE_TEXT[approval.state]}`) : null,
      rs ? checklistView(rs.gateChecks) : checklistView(GATE_CHECKS.map((c) => ({ ...c, state: "pending" }))),
      authorized ? el("div", { class: "authorized" }, "EXECUTION AUTHORIZED") : null);
  }

  function switchyardZone(rs) {
    const state = rs?.zones.switchyard ?? "idle";
    return zone("switchyard", "switch", "router", state, { concept: "Routing Switchyard", real: "tool-router · selectProvider" },
      el("div", { class: "incoming" }, "incoming job", rs?.ctx.capability ? el("b", {}, ` → ${rs.ctx.capability}`) : null),
      el("ul", { class: "patchbay" }, fs.model.capabilities.map((capability) => {
        const lineState = rs?.zones[`line:${capability.id}`] ?? (capability.connected ? "idle" : "unavailable");
        return el("li", { class: `line ${stateClass(lineState)}`, "data-zone": `line:${capability.id}` },
          el("span", { class: "jack", "aria-hidden": "true" }),
          el("span", { class: "cable", "aria-hidden": "true" }),
          el("span", { class: "line-name mono" }, capability.id),
          el("span", { class: "line-state" }, STATE_TEXT[lineState]));
      })));
  }

  function dispatchZone(rs) {
    const state = rs?.zones.dispatch ?? "idle";
    const decision = rs?.registryDecision;
    return zone("dispatch", "dispatch", "registry", state, { concept: "Dispatch Board", real: "provider registry" },
      el("table", { class: "board" },
        el("tbody", {}, fs.model.capabilities.map((capability) => {
          const providers = fs.model.providers.filter((p) => p.capability === capability.id && p.enabled);
          const selected = decision && decision.capability === capability.id;
          return el("tr", { class: selected ? (decision.selected ? "sel" : "miss") : "" },
            el("td", { class: "mono" }, capability.id),
            el("td", {}, "→"),
            el("td", {}, providers.length ? providers.map((p) => p.displayName).join(", ") : el("span", { class: "faint" }, "Unassigned")));
        }))),
      decision
        ? el("p", { class: "z-note" }, decision.selected ? `Registry selected ${decision.selected} (priority ${decision.candidates?.find((c) => c.providerId === decision.selected)?.priority ?? "?"}, ${decision.candidates?.length ?? 0} candidate). The producer did not choose it.` : "No enabled provider for this capability.")
        : el("p", { class: "z-note faint" }, "Provider selection happens here, never in the producer studio."));
  }

  function gatesZone(rs) {
    const used = rs?.ctx.providerId;
    return el("div", { class: "a-gates gates" }, fs.model.providers.map((provider) => {
      const id = `gate:${provider.providerId}`;
      const state = rs?.zones[id] ?? "idle";
      const events = provider.providerId === used ? rs.events : [];
      const out = [
        ["Avatars contract → adapter input", events.some((e) => e.type === "adapter.called")],
        ["Provider request (client call)", events.some((e) => e.type === "provider.submitted" || e.type === "provider.request")],
      ];
      const returned = events.find((e) => e.type === "adapter.returned");
      const contract = events.find((e) => e.type === "adapter.contract_validated" || e.type === "adapter.contract_rejected");
      const back = [
        ["Raw response validated", events.some((e) => e.type === "provider.response_validated" || e.type === "provider.output_received" || (e.type === "provider.response" && e.step !== "composition_plan"))],
        // A provider failure still comes back through the adapter as a normalized error result.
        [returned && !returned.ok ? `Adapter returned error · ${returned.errorCode ?? "unknown"}` : "Adapter result returned", returned ? (returned.ok ? true : "fail") : false],
        [contract?.type === "adapter.contract_validated" && !contract.ok ? "Failure result (valid contract)" : "Artifact contract",
          contract?.type === "adapter.contract_rejected" ? "fail" : contract ? true : false],
      ];
      const line = ([text, done]) => el("li", { class: done === "fail" ? "ck-failed" : done ? "ck-done" : "ck-pending" }, el("span", { class: "ck-mark" }, done === "fail" ? "✕" : done ? "✓" : "○"), text);
      return el("section", {
        class: `zone gate ${stateClass(state)}`,
        "data-zone": id,
        tabindex: "0",
        role: "button",
        "aria-label": `Translation gate ${provider.displayName}: ${STATE_TEXT[state]}`,
        onclick: (event) => { event.stopPropagation(); openInspector("adapter", id); },
      },
        el("header", { class: "z-head" },
          el("div", {}, el("div", { class: "z-concept" }, "Translation Gate"), el("div", { class: "z-real mono" }, provider.providerId)),
          stateTag(state)),
        el("div", { class: "gate-lanes" },
          el("div", {}, el("div", { class: "z-sub" }, "Outbound ↗"), el("ol", { class: "checklist" }, out.map(line))),
          el("div", {}, el("div", { class: "z-sub" }, "Inbound ↙"), el("ol", { class: "checklist" }, back.map(line)))));
    }));
  }

  function unitsColumn(rs) {
    return el("div", { class: "units" },
      el("div", { class: "units-title" }, "External Production Units"),
      fs.model.units.map((unit) => {
        const id = `unit:${unit.id}`;
        const state = rs?.zones[id] ?? "idle";
        const mine = rs?.ctx.unitId === unit.id;
        const steps = mine ? rs.unitSteps : null;
        const providers = fs.model.providers.filter((p) => p.unit.id === unit.id);
        const last = mine ? rs.events.filter((e) => e.type.startsWith("provider.")).at(-1) : null;
        return el("section", {
          class: `zone unit ${stateClass(state)}`,
          "data-zone": id,
          tabindex: "0",
          role: "button",
          "aria-label": `${unit.name}: ${STATE_TEXT[state]}`,
          onclick: (event) => { event.stopPropagation(); openInspector("provider", id); },
        },
          el("header", { class: "z-head" },
            el("div", {}, el("div", { class: "z-concept" }, unit.name), el("div", { class: "z-real mono" }, unit.endpoint)),
            stateTag(state)),
          kv([
            ["Serves", providers.map((p) => p.capability).join(", ")],
            ["Credentials", providers.every((p) => p.credentialsConfigured === true) ? "Configured" : providers.some((p) => p.credentialsConfigured === false) ? "Missing" : "Not exposed"],
          ]),
          steps
            ? el("ol", { class: "checklist" }, steps.map((step) => el("li", { class: step.state === "done" ? "ck-done" : "ck-pending" },
                el("span", { class: "ck-mark" }, step.state === "done" ? "✓" : "○"), step.label,
                step.at ? el("span", { class: "faint" }, ctx.fmtClockTime(step.at).slice(0, 8)) : null)))
            : unit.kind ? null : el("p", { class: "faint" }, "Processing not exposed."),
          mine && state === "active" && last ? el("p", { class: "z-note" }, describeEvent(last), " · ", elapsed(rs.stages.find((s) => s.id === "provider")?.since, rs)) : null,
          el("p", { class: "z-note faint" }, "Internal provider state beyond these steps is not exposed."));
      }));
  }

  function vaultZone(rs, job) {
    const state = rs?.zones.vault ?? "idle";
    // During a replay the vault fills only once the cursor has passed the completion.
    const reached = rs?.events.some((e) => e.type === "job.completed")
      || (job?.status === "completed" && !rs?.run.events.some((e) => e.type === "job.completed"));
    const artifacts = reached ? job?.artifacts ?? [] : [];
    return zone("vault", "vault", "vault", state, { concept: "Output Vault", real: "artifact storage · normalized result" },
      artifacts.length
        ? artifacts.map((artifact) => el("div", { class: "artifact" },
            kv([
              ["Role", artifact.role],
              ["File", el("span", { class: "mono" }, artifact.fileName)],
              ["Provider", artifact.providerId],
              ["Capability", artifact.capability],
              ["Path", el("span", { class: "mono" }, artifact.path)],
              ["Duration", artifact.durationSeconds ? `${artifact.durationSeconds} s` : job?.capability === "MUSIC_GENERATION" ? `${job.musicLengthMs / 1000} s (requested)` : null],
              ["Sample rate", artifact.sampleRate ? `${artifact.sampleRate} Hz` : null],
              ["Seed", artifact.seed],
              ["Content type", artifact.contentType],
              ["Size", ctx.fmtBytes(artifact.bytes)],
              ["Created", job?.updatedAt ? ctx.fmtClockTime(job.updatedAt) : null],
              ["Status", statusAt(rs) ?? job?.status],
            ].filter((row) => row[1] !== null && row[1] !== undefined)),
            el("button", {
              class: "play-btn",
              type: "button",
              onclick: (event) => {
                event.stopPropagation();
                ctx.player.play({ path: artifact.path, title: artifact.fileName, producerName: ctx.producerName(job.producerId), meta: artifact.role, jobId: job.jobId });
              },
            }, "▶ Play")))
        : el("p", { class: "faint" }, rs?.outcome === "failed" ? "Nothing reached the vault." : "Empty."));
  }

  function routesZone(rs) {
    return el("section", { class: "zone a-routes routes", "data-zone": "routes", onclick: (event) => { event.stopPropagation(); openInspector("workflow", "routes"); } },
      el("header", { class: "z-head" }, el("div", {}, el("div", { class: "z-concept" }, "Production Routes"), el("div", { class: "z-real mono" }, "WorkflowDefinitions")), el("span", {})),
      fs.model.workflows.map((workflow) => {
        const active = rs?.ctx.workflowId === workflow.id;
        return el("div", { class: `route ${active ? "on" : ""}` },
          el("div", { class: "route-name mono" }, workflow.id),
          el("ol", { class: "route-stops" }, workflow.steps.map((step) => {
            const lineState = active && step.capability === rs.ctx.capability ? (rs.zones[`line:${step.capability}`] ?? "active")
              : step.status === "READY" ? "idle" : step.status === "WAITING_FOR_GATE" ? "idle" : "unavailable";
            return el("li", { class: stateClass(lineState), title: step.status },
              el("span", { class: "mono" }, step.capability), step.required ? null : el("span", { class: "faint" }, " optional"));
          })));
      }));
  }

  // ---------- strips ----------

  function cpnStrip(rs) {
    const current = rs?.current;
    const currentText = !rs ? "Idle"
      : rs.outcome === "completed" ? "Production completed · artifact in the Output Vault"
      : current ? `${current.label} · ${STATE_TEXT[current.state] ?? current.state}`
        : OUTCOME_TEXT[rs.outcome] ?? rs.outcome;
    return el("div", { class: "cpn" },
      el("div", { class: "cpn-col cpn-current" }, el("div", { class: "cpn-k" }, "Current"),
        el("div", { class: "cpn-v" }, currentText, current?.since && ["active", "waiting"].includes(current.state) ? [" · ", elapsed(current.since, rs)] : null)),
      el("div", { class: "cpn-col" }, el("div", { class: "cpn-k" }, "Completed"),
        el("div", { class: "cpn-list" }, rs?.completed.length ? rs.completed.map((s) => el("span", {}, s.label)) : el("span", { class: "faint" }, "—"))),
      el("div", { class: "cpn-col" }, el("div", { class: "cpn-k" }, "Next"),
        el("div", { class: "cpn-list" }, rs?.next.length ? rs.next.slice(0, 6).map((s) => el("span", {}, s.label)) : el("span", { class: "faint" }, "—"))));
  }

  function timeline(rs) {
    if (!rs) return el("div", { class: "tl" }, el("p", { class: "faint" }, "No recorded runs yet. Give a producer a brief (web studio or Codex/Claude) and the facility will light up step by step."));
    const atCursor = rs.events.at(-1);
    return el("div", { class: "tl" },
      el("ol", { class: "tl-stages" }, rs.stages.map((stage) => el("li", {
        class: stateClass(stage.state),
        tabindex: "0",
        role: "button",
        onclick: () => openInspector(stage.component, stage.zone, stage.id),
      },
        el("span", { class: "tl-dot", "aria-hidden": "true" }),
        el("span", { class: "tl-name" }, stage.label),
        el("span", { class: "tl-time mono" },
          stage.at ? ctx.fmtClockTime(stage.at).slice(0, 8) : "",
          stage.duration ? ` +${ctx.fmtDuration(stage.duration)}` : "")))),
      el("div", { class: "tl-controls" },
        el("button", { type: "button", class: "tl-btn", "aria-label": "Başa sar", onclick: () => setCursor(1) }, "⏮"),
        el("button", { type: "button", class: "tl-btn", "aria-label": "Bir olay geri", onclick: () => setCursor((fs.cursor ?? rs.total) - 1) }, "◀"),
        el("button", { type: "button", class: "tl-btn", "aria-label": fs.replayTimer ? "Durdur" : "Kaydı oynat", onclick: toggleReplay }, fs.replayTimer ? "❚❚" : "▶"),
        el("button", { type: "button", class: "tl-btn", "aria-label": "Bir olay ileri", onclick: () => setCursor((fs.cursor ?? rs.total) + 1) }, "▶|"),
        el("input", {
          type: "range", min: 1, max: rs.total, value: rs.cursor, "aria-label": "Olay konumu",
          oninput: (event) => setCursor(Number(event.target.value)),
        }),
        el("span", { class: "mono faint" }, `${rs.cursor}/${rs.total}`),
        el("button", { type: "button", class: `tl-btn live ${fs.follow ? "on" : ""}`, onclick: goLive }, ctx.showcase ? "END" : "LIVE")),
      atCursor ? el("div", { class: "tl-event" }, el("span", { class: "mono faint" }, `${ctx.fmtClockTime(atCursor.at)} · ${atCursor.type}`), " ", describeEvent(atCursor)) : null);
  }

  function historyPanel(runs, current) {
    return el("div", { class: `history ${fs.historyOpen ? "open" : ""}` },
      el("div", { class: "history-head" }, el("span", {}, "Job History · real runs"), el("button", { type: "button", class: "tl-btn", onclick: () => { fs.historyOpen = false; update(); } }, "×")),
      el("ol", {}, runs.slice(0, 60).map((run) => {
        const rs = runState(run, fs.model);
        const failedAt = rs.outcome === "failed" ? rs.current : null;
        return el("li", {
          class: run.key === current?.key ? "sel" : "",
          tabindex: "0",
          role: "button",
          onclick: () => {
            fs.follow = false;
            fs.selectedKey = run.key;
            fs.cursor = null;
            fs.historyOpen = false;
            stopReplay();
            update();
          },
        },
          el("div", { class: "h-top" }, el("b", {}, ctx.producerName(run.producerId) ?? "—"), el("span", { class: `z-state st-${run.outcome === "completed" ? "completed" : run.outcome === "failed" ? "failed" : ACTIVE_OUTCOMES.has(run.outcome) ? "active" : "idle"}` }, OUTCOME_TEXT[run.outcome])),
          el("div", { class: "h-req" }, run.request ? run.request.slice(0, 70) : run.jobId ?? run.key),
          el("div", { class: "h-meta mono" }, [rs.ctx.workflowId, rs.ctx.capability, rs.ctx.providerId].filter(Boolean).join(" · ") || "—"),
          failedAt ? el("div", { class: "h-fail" }, `✕ ${failedAt.label}`) : null,
          run.attempts > 1 ? el("div", { class: "h-meta" }, `${run.attempts} prepare attempts`) : null,
          el("div", { class: "faint h-time" }, ctx.fmtTime(run.startedAt)));
      })));
  }

  // ---------- inspector (reality layer) ----------

  function openInspector(componentId, zoneId, stageId = null) {
    fs.inspect = { componentId, zoneId, stageId };
    void renderInspector();
  }

  async function renderInspector() {
    const panel = root?.querySelector(".inspector");
    if (!panel) return;
    if (!fs.inspect) {
      panel.classList.remove("open");
      fill(panel);
      return;
    }
    const runs = allRuns();
    const run = selectedRun(runs);
    const rs = run ? runState(run, fs.model, fs.cursor ?? run.events.length) : null;
    const comp = component(fs.inspect.componentId);
    const stages = rs?.stages.filter((s) => s.component === fs.inspect.componentId && (!fs.inspect.zoneId || s.zone === fs.inspect.zoneId || fs.inspect.componentId !== "adapter")) ?? [];
    const belongs = COMPONENT_EVENTS[fs.inspect.componentId];
    const related = (belongs ? (rs?.events ?? []).filter((e) => belongs(e.type)) : [...new Set(stages.flatMap((s) => s.related ?? []))])
      .sort((a, b) => a.at.localeCompare(b.at));
    const first = related[0];
    const last = related.at(-1);
    const job = rs?.run.jobId ? await jobDetail(rs.run.jobId, rs.run.lastAt) : null;
    const zoneState = rs?.zones[fs.inspect.zoneId] ?? (fs.inspect.zoneId?.startsWith("line:") ? "idle" : "idle");

    fill(panel,
      el("div", { class: "insp-head" },
        el("div", {}, el("div", { class: "z-sub" }, "Reality layer"), el("h3", {}, comp?.concept ?? fs.inspect.componentId)),
        el("button", { type: "button", class: "tl-btn", "aria-label": "Kapat", onclick: () => { fs.inspect = null; void renderInspector(); } }, "×")),
      kv([
        ["Concept role", comp?.concept],
        ["Real component", comp?.real],
        ["Module / file", comp ? el("ul", { class: "srcs" }, comp.sources.map((s) => el("li", { class: s.exists ? "" : "missing" }, el("span", { class: "mono" }, s.path), s.exists ? "" : " · missing"))) : null],
        ["Current state", STATE_TEXT[zoneState] ?? zoneState],
        ["Stages", stages.length ? stages.map((s) => `${s.label}: ${STATE_TEXT[s.state] ?? s.state}`).join(" · ") : null],
        ["Started", first ? ctx.fmtClockTime(first.at) : null],
        ["Finished", last && stages.every((s) => s.state === "completed") ? ctx.fmtClockTime(last.at) : null],
        ["Duration", first && last && first !== last ? ctx.fmtDuration(new Date(last.at) - new Date(first.at)) : null],
        ["Related job", rs?.run.jobId ? el("a", { href: `#/sessions/${encodeURIComponent(rs.run.jobId)}`, class: "mono" }, rs.run.jobId) : null],
      ]),
      inspectorExtra(fs.inspect.componentId, rs, job),
      el("div", { class: "z-sub", style: { "margin-top": "18px" } }, related.length ? "Runtime events (input / output)" : "No runtime events for this component in the selected run"),
      el("ol", { class: "insp-events" }, related.map((event) => {
        const data = Object.fromEntries(Object.entries(event).filter(([key]) => !META_KEYS.has(key)));
        return el("li", {},
          el("div", {}, el("span", { class: "mono faint" }, ctx.fmtClockTime(event.at)), " ", el("b", { class: "mono" }, event.type)),
          el("div", { class: "faint" }, describeEvent(event)),
          Object.keys(data).length ? el("pre", { class: "insp-json" }, JSON.stringify(data, null, 2).slice(0, 2400)) : null);
      })));
    panel.classList.add("open");
  }

  function inspectorExtra(componentId, rs, job) {
    if (componentId === "knowledge" && job?.briefContext) return el("div", { class: "insp-extra" }, el("div", { class: "z-sub" }, "brief_context (resolved packs only)"), ctx.briefContextPanel(job.briefContext));
    if (componentId === "brief" && (rs?.brief || job?.creativeBrief)) return el("div", { class: "insp-extra" }, el("div", { class: "z-sub" }, "Creative brief (provider neutral)"), el("pre", { class: "insp-json" }, rs?.brief ?? job.creativeBrief), job?.finalPrompt ? [el("div", { class: "z-sub" }, "Final prompt (orchestrator composed)"), el("pre", { class: "insp-json" }, job.finalPrompt)] : null);
    if (componentId === "registry") {
      return el("div", { class: "insp-extra" }, el("div", { class: "z-sub" }, "Registry snapshot"), el("table", { class: "board" }, el("tbody", {}, fs.model.providers.map((p) =>
        el("tr", {}, el("td", { class: "mono" }, p.capability), el("td", {}, p.displayName), el("td", { class: "mono" }, `priority ${p.priority}`), el("td", {}, p.enabled ? "enabled" : "disabled"))))));
    }
    if (componentId === "provider" || componentId === "adapter") {
      return el("div", { class: "insp-extra" }, el("div", { class: "z-sub" }, "Providers"), el("table", { class: "board" }, el("tbody", {}, fs.model.providers.map((p) =>
        el("tr", {}, el("td", { class: "mono" }, p.providerId), el("td", {}, p.unit.name), el("td", { class: "mono" }, p.adapterSource?.path ?? "—"), el("td", {}, p.credentialsConfigured === null ? "—" : p.credentialsConfigured ? "Configured" : "Missing"))))));
    }
    if (componentId === "workflow") {
      return el("div", { class: "insp-extra" }, fs.model.workflows.map((w) => el("div", {}, el("b", { class: "mono" }, w.id), el("p", { class: "faint" }, w.description), el("p", { class: "mono" }, w.steps.map((s) => `${s.capability}${s.required ? "" : "?"} [${s.status}]`).join(" → ")))));
    }
    if (componentId === "job" && job) {
      return el("div", { class: "insp-extra" }, el("div", { class: "z-sub" }, "Lifecycle (job file)"), el("ol", { class: "insp-events" }, job.lifecycle.map((e) => el("li", {}, `${e.label} · ${e.state}${e.at ? ` · ${ctx.fmtClockTime(e.at)}` : ""}`))));
    }
    if (componentId === "execute" && job?.error) return el("div", { class: "insp-extra" }, el("div", { class: "z-sub" }, "Error"), el("pre", { class: "insp-json" }, job.error));
    return null;
  }

  // ---------- wires and the production case ----------

  function center(zoneId) {
    const node = plan?.querySelector(`[data-zone="${CSS.escape(zoneId)}"]`);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const base = plan.getBoundingClientRect();
    return { x: box.left - base.left + box.width / 2, y: box.top - base.top + box.height / 2, box, base };
  }

  function drawWires(rs) {
    const svg = plan?.querySelector(".wires");
    if (!svg || !plan) return;
    const base = plan.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${base.width} ${base.height}`);
    svg.replaceChildren();
    if (!rs) return;
    const path = [];
    for (const stage of rs.stages) {
      if (!stage.zone || stage.zone.includes("null")) continue;
      if (path.at(-1)?.zone === stage.zone) {
        path.at(-1).state = mergeState(path.at(-1).state, stage.state);
        continue;
      }
      path.push({ zone: stage.zone, state: stage.state });
    }
    // The capability line is part of the switchyard route.
    const routerIndex = path.findIndex((p) => p.zone === "switchyard");
    if (routerIndex >= 0 && rs.ctx.capability) path.splice(routerIndex + 1, 0, { zone: `line:${rs.ctx.capability}`, state: path[routerIndex].state });
    for (let i = 1; i < path.length; i += 1) {
      const a = center(path[i - 1].zone);
      const b = center(path[i].zone);
      if (!a || !b) continue;
      const state = path[i].state === "completed" ? "done" : ["active", "waiting", "failed", "awaiting_provider"].includes(path[i].state) ? path[i].state : "todo";
      const mid = (a.x + b.x) / 2;
      const d = Math.abs(a.y - b.y) < 4 ? `M${a.x},${a.y} H${b.x}` : `M${a.x},${a.y} H${mid} V${b.y} H${b.x}`;
      const wire = document.createElementNS("http://www.w3.org/2000/svg", "path");
      wire.setAttribute("d", d);
      wire.setAttribute("class", `wire w-${state}`);
      svg.append(wire);
    }
  }

  function mergeState(a, b) {
    const rank = { pending: 0, skipped: 0, completed: 1, waiting: 2, awaiting_provider: 2, active: 3, failed: 4 };
    return (rank[b] ?? 0) > (rank[a] ?? 0) ? b : a;
  }

  function placeCase(rs) {
    if (!caseToken || !plan) return;
    const jobStage = rs?.stages.find((s) => s.id === "job");
    if (!rs || !jobStage || jobStage.state !== "completed") {
      caseToken.classList.remove("show");
      return;
    }
    const target = rs.outcome === "completed" ? "vault"
      : rs.current?.zone && !rs.current.zone.includes("null") ? rs.current.zone : "case";
    const point = center(target);
    if (!point) return;
    // The case sits on the room's lower edge like a tag, so it never covers the room title.
    const x = point.box.right - point.base.left - 10;
    const y = point.box.bottom - point.base.top;
    caseToken.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-100%, -50%)`;
    caseToken.className = `case-token show ${stateClass(rs.outcome === "failed" ? "failed" : rs.outcome === "completed" ? "completed" : "active")} ${target.startsWith("unit:") ? "outside" : ""}`;
    fill(caseToken,
      el("span", { class: "case-k" }, "CASE"),
      el("span", { class: "mono" }, (rs.run.jobId ?? "").slice(-17)),
      el("span", { class: "case-s" }, OUTCOME_TEXT[rs.outcome] ?? rs.outcome));
  }

  // ---------- replay ----------

  function setCursor(value) {
    const runs = allRuns();
    const run = selectedRun(runs);
    if (!run) return;
    fs.follow = false;
    fs.selectedKey = run.key;
    fs.cursor = Math.max(1, Math.min(run.events.length, value));
    update();
  }

  function stopReplay() {
    if (fs.replayTimer) clearTimeout(fs.replayTimer);
    fs.replayTimer = null;
  }

  // Replays the recorded events with their real spacing, compressed (max 1.2 s per gap).
  function toggleReplay() {
    if (fs.replayTimer) {
      stopReplay();
      update();
      return;
    }
    const run = selectedRun(allRuns());
    if (!run) return;
    fs.follow = false;
    fs.selectedKey = run.key;
    if (!fs.cursor || fs.cursor >= run.events.length) fs.cursor = 1;
    const step = () => {
      const current = run.events[fs.cursor - 1];
      fs.cursor += 1;
      update();
      if (fs.cursor >= run.events.length) {
        stopReplay();
        update();
        return;
      }
      const gap = new Date(run.events[fs.cursor - 1].at) - new Date(current.at);
      fs.replayTimer = setTimeout(step, Math.min(1200, Math.max(120, gap / 8)));
    };
    fs.replayTimer = setTimeout(step, 200);
    update();
  }

  function goLive() {
    stopReplay();
    fs.follow = true;
    fs.selectedKey = null;
    fs.cursor = null;
    update();
  }

  // ---------- render ----------

  async function update() {
    if (!root || !document.body.contains(root)) return;
    const runs = allRuns();
    const run = selectedRun(runs);
    const rs = run ? runState(run, fs.model, fs.cursor ?? run.events.length) : null;
    const job = rs?.run.jobId && rs.events.some((e) => e.type === "job.persisted" || e.type === "execute.job_loaded" || e.type === "agent.job_linked")
      ? await jobDetail(rs.run.jobId, rs.run.lastAt) : null;
    if (!document.body.contains(root)) return;

    const live = runs.some((r) => ACTIVE_OUTCOMES.has(r.outcome) && Date.now() - new Date(r.lastAt) < 30 * 60_000);
    const systemStatus = rs && ACTIVE_OUTCOMES.has(rs.outcome) && fs.cursor === null ? "ACTIVE" : live ? "ACTIVE" : "IDLE";
    fill(root.querySelector(".fac-status"),
      el("div", { class: "fs-k" }, "Production system"),
      el("div", { class: `fs-v ${systemStatus === "ACTIVE" ? "on" : ""}` }, "STATUS ", el("b", {}, systemStatus)),
      Date.now() < fs.flashUntil ? el("div", { class: "flash" }, "NEW PRODUCTION REQUEST") : null);
    fill(root.querySelector(".fac-run"),
      rs ? [
        el("span", { class: "z-sub" }, ctx.showcase ? (fs.cursor ? "Replay" : "Snapshot") : fs.follow ? "Following live" : fs.cursor ? "Replay" : "History"),
        el("b", {}, ctx.producerName(rs.run.producerId) ?? "—"),
        el("span", { class: "mono faint" }, rs.run.jobId ?? rs.run.key),
        el("span", { class: `z-state st-${rs.outcome === "completed" ? "completed" : rs.outcome === "failed" ? "failed" : ACTIVE_OUTCOMES.has(rs.outcome) ? "active" : "idle"}` }, OUTCOME_TEXT[rs.outcome]),
      ] : el("span", { class: "faint" }, "No run selected"),
      el("button", { type: "button", class: "tl-btn", onclick: () => { fs.historyOpen = !fs.historyOpen; update(); } }, `Job History (${runs.length})`),
      fs.follow ? null : el("button", { type: "button", class: "tl-btn live", onclick: goLive }, ctx.showcase ? "Back to latest" : "Back to LIVE"));
    fill(root.querySelector(".fac-cpn"), cpnStrip(rs));

    fill(root.querySelector(".boundary-grid"),
      intakeZone(rs),
      studiosZone(rs),
      blueprintZone(rs, job),
      prepZone(rs),
      archiveZone(rs),
      caseZone(rs, job),
      towerZone(rs),
      switchyardZone(rs),
      dispatchZone(rs),
      gatesZone(rs),
      routesZone(rs),
      vaultZone(rs, job));
    fill(root.querySelector(".external"), unitsColumn(rs));
    fill(root.querySelector(".fac-timeline"), timeline(rs));
    fill(root.querySelector(".fac-history"), historyPanel(runs, run));

    requestAnimationFrame(() => {
      drawWires(rs);
      placeCase(rs);
    });
    ctx.tickTimers();
    if (fs.inspect) void renderInspector();
  }

  async function render(view) {
    await load();
    caseToken = el("div", { class: "case-token", "aria-hidden": "true" });
    root = el("div", { class: "fac", lang: "en" },
      el("header", { class: "fac-head" },
        el("div", { class: "fac-title" }, el("span", { class: "mono" }, "AVATARS 2"), el("span", { class: "sep" }, "//"), el("span", {}, "PRODUCTION FACILITY")),
        el("div", { class: "fac-status", role: "status" }),
        el("div", { class: "fac-run" })),
      el("div", { class: "fac-cpn" }),
      el("div", { class: "fac-plan", onclick: () => { if (fs.inspect) { fs.inspect = null; void renderInspector(); } } },
        el("svg", { class: "wires", "aria-hidden": "true" }),
        el("div", { class: "boundary" },
          el("div", { class: "boundary-label" }, "AVATARS 2 SYSTEM BOUNDARY"),
          el("div", { class: "boundary-grid" })),
        el("div", { class: "external" }),
        caseToken),
      el("div", { class: "fac-timeline" }),
      el("div", { class: "fac-history" }),
      el("aside", { class: "inspector", "aria-label": "Reality layer" }));
    // SVG elements need the SVG namespace; replace the placeholder created by el().
    const placeholder = root.querySelector(".wires");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "wires");
    svg.setAttribute("aria-hidden", "true");
    placeholder.replaceWith(svg);
    plan = root.querySelector(".fac-plan");
    fill(view, root);
    if (!resizeBound) {
      resizeBound = true;
      window.addEventListener("resize", () => {
        const run = selectedRun(allRuns());
        const rs = run ? runState(run, fs.model, fs.cursor ?? run.events.length) : null;
        drawWires(rs);
        placeCase(rs);
      });
    }
    await update();
  }

  function onTrace(events) {
    fs.events.push(...events);
    if (fs.events.length > 8000) fs.events.splice(0, fs.events.length - 8000);
    for (const run of groupRuns(fs.events)) {
      if (!fs.seen.has(run.key)) {
        fs.seen.add(run.key);
        fs.flashUntil = Date.now() + 5000;
        setTimeout(() => void update(), 5100);
      }
    }
    // Job files changed too; drop cached details for the jobs these events touch.
    for (const event of events) if (event.jobId) fs.jobs.delete(event.jobId);
    if (root && document.body.contains(root)) void update();
  }

  return { render, onTrace };
}
