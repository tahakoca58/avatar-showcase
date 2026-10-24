// Avatar — studio frontend. All data comes from the local API; this file holds no
// provider, registry or orchestration logic of its own.

import { createFacility } from "./facility.js";
import { SEASON, applySeason, producerAsset, producerTheme } from "./theme.js";

const view = document.getElementById("view");
const dialog = document.getElementById("execute-dialog");
const drawerRoot = document.getElementById("drawer-root");
const state = {
  system: null,
  jobs: [],
  studio: {},
  sessionByProducer: {},
  briefDrafts: {},
  libraryFilter: "all",
  sessionFilter: "all",
};

// ---------- DOM helpers ----------

// Uppercased labels are English; tagging them avoids Turkish casing ("İ") inside a lang="tr" page.
const UPPERCASE_LABEL = /\b(eyebrow|display|take-title|who|node-label|portal-cta|hero-word|filters|section-title|block-head|field)\b/;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  if (tag === "dt" || tag === "summary" || UPPERCASE_LABEL.test(attrs?.class ?? "")) node.lang = "en";
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "style" && typeof value === "object") {
      for (const [prop, val] of Object.entries(value)) node.style.setProperty(prop, val);
    } else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "html") throw new Error("Raw HTML is not allowed.");
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  // Turkish words in an uppercased label need Turkish casing ("BİLGİ", not "BILGI").
  if (node.lang === "en" && /[çğıöşüâÇĞİÖŞÜ]/.test(node.textContent)) node.lang = "tr";
  return node;
}

function fill(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", name === "pause" ? "M3.5 1.5h3v13h-3zM9.5 1.5h3v13h-3z" : "M4 1.8v12.4L14 8z");
  svg.append(path);
  return svg;
}

function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function fmtTime(value) {
  if (!value) return "";
  const date = new Date(value);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { day: "2-digit", month: "short" }) + " · " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

function fmtClock(seconds) {
  if (!Number.isFinite(seconds)) return "--:--";
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

const UPPER_WORDS = new Set(["uk", "ny", "edm", "lofi", "rnb", "k", "j"]);
function humanize(slug) {
  return String(slug ?? "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => (UPPER_WORDS.has(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

// Showcase builds (web/export-showcase.mjs) mark the page with <meta name="avatar-mode"
// content="showcase">: it then reads a read-only snapshot of real records instead of the
// local API, and every action (prepare, execute, agent conversation) is off.
const SHOWCASE = document.querySelector('meta[name="avatar-mode"]')?.content === "showcase";

function showcasePath(path) {
  const route = path.split("?")[0];
  const fixed = {
    "/api/system": "data/system.json",
    "/api/facility": "data/facility.json",
    "/api/trace": "data/trace.json",
    "/api/jobs": "data/jobs.json",
    "/api/outputs": "data/outputs.json",
    "/api/agent": "data/agent.json",
    "/api/agent/conversations": "data/conversations.json",
  };
  if (fixed[route]) return fixed[route];
  const job = /^\/api\/jobs\/([^/]+)$/.exec(route);
  return job ? `data/jobs/${job[1]}.json` : null;
}

function mediaUrl(path) {
  if (SHOWCASE) return `media/${encodeURIComponent(String(path).split("/").pop())}`;
  return `/api/media?path=${encodeURIComponent(path)}`;
}

// ---------- API ----------

async function api(path, options = {}) {
  if (SHOWCASE) {
    const mapped = options.method === "POST" ? null : showcasePath(path);
    if (!mapped) throw new Error("Bu bir vitrin: canlı işlemler kapalı.");
    const response = await fetch(mapped);
    if (!response.ok) throw new Error("Bu kayıt vitrinde yer almıyor.");
    return response.json();
  }
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });

async function loadSystem() {
  state.system = await api("/api/system");
  return state.system;
}

async function loadJobs() {
  state.jobs = (await api("/api/jobs")).jobs;
  return state.jobs;
}

// ---------- Domain display helpers ----------

const WORKFLOW_LABELS = {
  FULL_BEAT_WORKFLOW: "Full track",
  SAMPLE_BUILD_WORKFLOW: "Sample build",
};

const CAPABILITY_LABELS = {
  MUSIC_GENERATION: "Music Generation",
  SAMPLE_GENERATION: "Sample Generation",
  STEM_SEPARATION: "Stem Separation",
  ACCOMPANIMENT_GENERATION: "Accompaniment",
  DAW_CONTROL: "DAW Control",
  MASTERING: "Mastering",
  MIXING: "Mixing",
  AUDIO_ANALYSIS: "Audio Analysis",
  SFX_GENERATION: "SFX Generation",
};

// Formats a producer can prepare; each maps onto an existing workflow/capability pair.
const FORMATS = [
  { id: "track", label: "Full track", workflowId: "FULL_BEAT_WORKFLOW", capability: "MUSIC_GENERATION" },
  { id: "sample", label: "Sample", workflowId: "SAMPLE_BUILD_WORKFLOW", capability: "SAMPLE_GENERATION" },
  { id: "stems", label: "Stems", workflowId: "FULL_BEAT_WORKFLOW", capability: "STEM_SEPARATION" },
  { id: "fl", label: "FL Studio", workflowId: "FULL_BEAT_WORKFLOW", capability: "DAW_CONTROL" },
];

const CORE_STAGES = [
  { id: "request", name: "User Request" },
  { id: "producer", name: "Producer" },
  { id: "prepare", name: "producer_prepare" },
  { id: "job", name: "Persisted job" },
  { id: "brief", name: "Production brief" },
  { id: "execute", name: "producer_execute" },
  { id: "router", name: "Tool Router" },
  { id: "registry", name: "Provider Registry" },
  { id: "adapter", name: "Adapter" },
  { id: "provider", name: "Provider" },
  { id: "artifact", name: "Artifact" },
];

// Maps a persisted job status onto the technical pipeline stages.
function stageStates(job) {
  const order = CORE_STAGES.map((stage) => stage.id);
  const states = Object.fromEntries(order.map((id) => [id, "idle"]));
  if (!job) return states;
  const markDone = (untilId) => {
    for (const id of order.slice(0, order.indexOf(untilId) + 1)) states[id] = "completed";
  };
  switch (job.status) {
    case "prepared":
      markDone("job");
      states.brief = "prepared";
      break;
    case "running":
      markDone("adapter");
      states.provider = "running";
      break;
    case "completed":
      markDone("artifact");
      break;
    case "failed":
      markDone("adapter");
      states.provider = "failed";
      break;
    case "waiting_for_provider":
      markDone("router");
      states.registry = "waiting_for_provider";
      break;
    default:
      break;
  }
  return states;
}

function workflowById(workflowId) {
  return state.system?.workflows.find((w) => w.workflowId === workflowId);
}

function providerFor(capability) {
  return state.system?.providers.find((p) => p.capability === capability && p.enabled) ?? null;
}

function providerName(providerId) {
  return state.system?.providers.find((p) => p.providerId === providerId)?.displayName ?? providerId;
}

function producerById(producerId) {
  return state.system?.producers.find((p) => p.producerId === producerId) ?? null;
}

function producerNameOf(producerId) {
  return producerById(producerId)?.name ?? humanize(producerId);
}

function sessionTitle(job) {
  const base = job.outputName
    ? job.outputName.replace(new RegExp(`^${job.producerId}-`), "")
    : job.primaryGenre;
  return humanize(base);
}

const SESSION_PHRASES = {
  prepared: "Prepared — brief bekleniyor",
  running: "Generating",
  completed: "Completed",
  failed: "Failed",
  waiting_for_provider: "Waiting for provider",
};

function statusTone(status) {
  return { completed: "on", running: "live", failed: "fail", waiting_for_provider: "warn" }[status] ?? "";
}

function statusLine(status, text = SESSION_PHRASES[status] ?? status) {
  return el("span", { class: `status ${statusTone(status)}` }, text);
}

function stepStatus(step) {
  if (step.status === "READY") return el("span", { class: "status on" }, "Online");
  if (step.status === "WAITING_FOR_GATE") return el("span", { class: "status on" }, "Online · seçilmiş track sonrası");
  return el("span", { class: "status" }, "Not connected");
}

// ---------- Producer visual ----------

// Single place that renders producer imagery. Uses a real asset from theme.js when one
// is configured, otherwise a typographic portrait; it never invents an image.
function producerVisual(producer, { preference, eager = false, sizes = "(max-width: 820px) 100vw, 33vw" } = {}) {
  const theme = producerTheme(producer.producerId);
  const asset = producerAsset(producer.producerId, preference);
  const visual = el("div", { class: "visual", style: { "--accent-glow": theme.glow, "--tint": theme.tint } });
  if (asset) {
    visual.append(el("img", {
      src: asset.src,
      srcset: asset.srcset,
      sizes: asset.srcset ? sizes : null,
      width: asset.width,
      height: asset.height,
      alt: asset.alt ?? `${producer.name}`,
      loading: eager ? "eager" : "lazy",
      decoding: "async",
      fetchpriority: eager ? "high" : null,
    }));
  } else {
    visual.append(
      el("div", { class: "visual-initial", "aria-hidden": "true" }, producer.name[0]),
      el("div", { class: "visual-caption" },
        el("span", { class: "eyebrow" }, `${SEASON.label} look`),
        el("span", { class: "styling" }, theme.styling.join(" · ")),
        el("span", { class: "styling faint" }, theme.setting)));
  }
  return visual;
}

function applyProducerAccent(producerId) {
  const root = document.documentElement;
  if (!producerId) {
    for (const prop of ["--accent", "--accent-glow", "--tint"]) root.style.removeProperty(prop);
    return;
  }
  const theme = producerTheme(producerId);
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--accent-glow", theme.glow);
  root.style.setProperty("--tint", theme.tint);
}

// ---------- Signal flow ----------

function nodeClass(stageState) {
  return { completed: "completed", prepared: "current", running: "current", waiting_for_provider: "blocked", failed: "failed" }[stageState] ?? "";
}

function signalFlow(workflowId, job, { technical = true } = {}) {
  const workflow = workflowById(workflowId);
  const states = stageStates(job);
  const capability = job?.capability ?? workflow?.steps[0].capability;
  const provider = job?.providerId ?? providerFor(capability)?.providerId;
  const generationStates = ["execute", "router", "registry", "adapter", "provider"].map((id) => states[id]);
  const generationState = generationStates.find((s) => ["failed", "waiting_for_provider", "running"].includes(s))
    ?? (generationStates.every((s) => s === "completed") ? "completed" : "idle");
  const generationValue = {
    failed: "Failed",
    waiting_for_provider: "No provider",
    running: "Generating",
  }[generationState] ?? (provider ? providerName(provider) : "Not connected");

  const nodes = [
    { label: "Request", value: job?.userRequest ? `“${job.userRequest.slice(0, 48)}${job.userRequest.length > 48 ? "…" : ""}”` : "—", state: states.request },
    { label: "Producer", value: job ? producerNameOf(job.producerId) : "—", state: states.producer },
    { label: "Prepared", value: job ? "Session saved" : "—", state: states.job },
    { label: "Brief", value: states.brief === "prepared" ? "Awaiting brief" : "Production brief", state: states.brief },
    { label: CAPABILITY_LABELS[capability] ?? "Generation", value: generationValue, state: generationState },
    { label: "Artifact", value: job?.status === "completed" ? "Take ready" : "—", state: states.artifact },
  ];

  const downstream = (workflow?.steps ?? []).filter((step) => step.capability !== capability);
  return el("div", {},
    el("ol", { class: "signal", "aria-label": "Signal flow" }, nodes.map((node) =>
      el("li", { class: `node ${nodeClass(node.state)}` },
        el("span", { class: "jack", "aria-hidden": "true" }),
        el("div", { class: "node-label" }, node.label),
        el("div", { class: "node-value" }, node.value),
        el("span", { class: "sr-only" }, ` — ${node.state.replaceAll("_", " ")}`)))),
    downstream.length
      ? el("div", { class: "signal-tail" }, el("span", { class: "eyebrow" }, "Then"),
          downstream.map((step) => el("span", {}, `${CAPABILITY_LABELS[step.capability] ?? step.capability} — `,
            step.status === "READY" ? "online" : step.status === "WAITING_FOR_GATE" ? "seçilmiş track sonrası" : "not connected")))
      : null,
    technical
      ? el("details", { class: "disclosure", style: { "margin-top": "16px" } },
          el("summary", {}, "Technical path"),
          el("div", { class: "disclosure-body" },
            el("ol", { class: "timeline" }, CORE_STAGES.map((stage) => {
              const s = states[stage.id];
              const cls = { completed: "done", prepared: "active", running: "active", waiting_for_provider: "blocked", failed: "failed" }[s] ?? "";
              return el("li", { class: cls }, el("span", { class: "dot" }), el("span", { class: "mono" }, stage.name), el("time", {}, s.replaceAll("_", " ")));
            }))))
      : null);
}

// ---------- Now playing ----------

const player = (() => {
  const audio = document.getElementById("dock-audio");
  const dock = document.getElementById("dock");
  const toggle = document.getElementById("dock-toggle");
  const title = document.getElementById("dock-title");
  const label = document.getElementById("dock-label");
  const seek = document.getElementById("dock-seek");
  const current = document.getElementById("dock-current");
  const duration = document.getElementById("dock-duration");
  const download = document.getElementById("dock-download");
  const details = document.getElementById("dock-details");
  let track = null;

  function syncButtons() {
    const playing = !audio.paused;
    toggle.replaceChildren(icon(playing ? "pause" : "play"));
    toggle.setAttribute("aria-label", playing ? "Duraklat" : "Oynat");
    for (const button of document.querySelectorAll(".play[data-path]")) {
      const active = track && button.dataset.path === track.path && playing;
      button.replaceChildren(icon(active ? "pause" : "play"));
      button.setAttribute("aria-label", `${active ? "Duraklat" : "Oynat"}: ${button.dataset.title}`);
      button.closest(".take")?.classList.toggle("playing", Boolean(track && button.dataset.path === track.path));
    }
  }

  function syncProgress() {
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    seek.value = String(Math.round(pct * 10));
    seek.style.setProperty("--pct", `${pct}%`);
    current.textContent = fmtClock(audio.currentTime);
    duration.textContent = fmtClock(audio.duration);
  }

  toggle.addEventListener("click", () => (audio.paused ? audio.play() : audio.pause()));
  seek.addEventListener("input", () => {
    if (audio.duration) audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
  });
  for (const event of ["play", "pause", "ended"]) audio.addEventListener(event, syncButtons);
  for (const event of ["timeupdate", "loadedmetadata", "durationchange"]) audio.addEventListener(event, syncProgress);
  syncButtons();

  return {
    play(next) {
      if (track?.path === next.path) {
        if (audio.paused) audio.play();
        else audio.pause();
        return;
      }
      track = next;
      audio.src = mediaUrl(next.path);
      label.textContent = next.producerName ? `Now playing · ${next.producerName}` : "Now playing";
      title.textContent = [next.title, next.meta].filter(Boolean).join(" — ");
      download.href = mediaUrl(next.path);
      download.setAttribute("download", next.path.split("/").pop());
      details.hidden = !next.jobId;
      if (next.jobId) details.href = `#/sessions/${encodeURIComponent(next.jobId)}`;
      dock.hidden = false;
      audio.play().catch(() => syncButtons());
    },
    sync: syncButtons,
  };
})();

function playButton(take) {
  return el("button", {
    class: "play",
    type: "button",
    "data-path": take.path,
    "data-title": take.title,
    "aria-label": `Oynat: ${take.title}`,
    onclick: () => player.play(take),
  }, icon("play"));
}

// ---------- Takes (artifacts presented as releases) ----------

const KIND_LABEL = { track: "Take", sample: "Sample", stem: "Stem" };

function titleFromFile(fileName, producerId) {
  let base = fileName.replace(/\.[a-z0-9]+$/i, "").replace(/-\d{8}T\d{6}Z-[a-f0-9]{8}$/i, "");
  if (producerId) base = base.replace(new RegExp(`^${producerId}-`), "");
  return humanize(base);
}

function producerFromFile(fileName) {
  return state.system?.producers.find((p) => fileName.startsWith(`${p.producerId}-`))?.producerId ?? null;
}

// Builds take records from real /api/outputs entries plus their linked job details.
async function loadTakes() {
  const [{ groups }, jobs] = await Promise.all([api("/api/outputs"), state.jobs.length ? state.jobs : loadJobs()]);
  const linkedIds = [...new Set(groups.flatMap((g) => g.items.map((i) => i.jobId)).filter(Boolean))];
  const details = Object.fromEntries(await Promise.all(linkedIds.map(async (id) => {
    try {
      return [id, await api(`/api/jobs/${encodeURIComponent(id)}`)];
    } catch {
      return [id, null];
    }
  })));

  const kindByGroup = {
    tracks: "track",
    samples: "sample",
    "demucs-stems": "stem",
    "eleven-stems": "stem",
  };
  const providerByGroup = {
    tracks: "Eleven Music",
    samples: "Stable Audio 3 Medium",
    "demucs-stems": "Demucs",
    "eleven-stems": "ElevenLabs Stem Separation",
  };
  const takes = groups.flatMap((group) => group.items.map((item) => {
    const job = item.jobId ? details[item.jobId] : null;
    const summary = item.jobId ? jobs.find((j) => j.jobId === item.jobId) : null;
    const producerId = job?.producerId ?? summary?.producerId ?? producerFromFile(item.group ?? item.fileName);
    const artifact = job?.artifacts?.find((a) => a.path === item.path) ?? null;
    const seconds = artifact?.durationSeconds ?? (job?.capability === "MUSIC_GENERATION" && job.musicLengthMs ? job.musicLengthMs / 1000 : null);
    const kind = kindByGroup[group.id];
    return {
      ...item,
      kind,
      producerId,
      producerName: producerId ? producerNameOf(producerId) : null,
      title: kind === "stem" ? `${titleFromFile(item.group ?? "", producerId)} · ${humanize(item.fileName.replace(/\.[a-z0-9]+$/i, ""))}` : titleFromFile(item.fileName, producerId),
      seconds,
      format: item.fileName.split(".").pop().toUpperCase(),
      providerLabel: artifact?.providerId ? providerName(artifact.providerId) : providerByGroup[group.id],
      artifact,
    };
  }));

  // Numbering follows creation order within each kind.
  for (const kind of Object.keys(KIND_LABEL)) {
    takes.filter((t) => t.kind === kind)
      .sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt))
      .forEach((take, index) => { take.number = String(index + 1).padStart(2, "0"); });
  }
  return takes.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function takeCard(take) {
  const meta = [take.producerName, take.seconds ? `${take.seconds} sec` : null, take.format, take.providerLabel].filter(Boolean).join(" · ");
  const a = take.artifact;
  return el("article", { class: "take", style: take.producerId ? { "--accent-glow": producerTheme(take.producerId).glow } : null },
    el("div", { class: "eyebrow" }, `${KIND_LABEL[take.kind]} ${take.number ?? ""}`),
    el("h3", { class: "take-title" }, take.title || take.fileName),
    el("div", { class: "take-meta" }, meta),
    el("div", { class: "take-actions" },
      playButton({ path: take.path, title: take.title, producerName: take.producerName, meta: [take.seconds ? `${take.seconds}s` : null, take.format].filter(Boolean).join(" · "), jobId: take.jobId }),
      take.jobId ? el("a", { href: `#/sessions/${encodeURIComponent(take.jobId)}`, class: "take-meta" }, "Session") : null),
    el("details", {},
      el("summary", {}, "Details"),
      el("dl", { class: "kv", style: { "margin-top": "10px" } },
        el("dt", {}, "File"), el("dd", { class: "mono" }, take.fileName),
        el("dt", {}, "Role"), el("dd", {}, a?.role ?? take.kind),
        el("dt", {}, "Capability"), el("dd", {}, a?.capability ?? "—"),
        el("dt", {}, "Provider"), el("dd", {}, a?.providerId ?? take.providerLabel),
        el("dt", {}, "Model"), el("dd", {}, a?.model ?? "—"),
        el("dt", {}, "Duration"), el("dd", {}, a?.durationSeconds ? `${a.durationSeconds} s` : take.seconds ? `${take.seconds} s` : "—"),
        el("dt", {}, "Sample rate"), el("dd", {}, a?.sampleRate ? `${a.sampleRate} Hz` : "—"),
        el("dt", {}, "Seed"), el("dd", {}, a?.seed ?? "—"),
        el("dt", {}, "Content type"), el("dd", {}, take.contentType ?? "—"),
        el("dt", {}, "Size"), el("dd", {}, fmtBytes(take.bytes)),
        el("dt", {}, "Created"), el("dd", {}, fmtDate(take.modifiedAt)))));
}

function artifactTakes(job) {
  return job.artifacts.map((artifact, index) => ({
    path: artifact.path,
    fileName: artifact.fileName,
    kind: artifact.role === "sample" ? "sample" : artifact.role === "stem" ? "stem" : "track",
    number: String(index + 1).padStart(2, "0"),
    producerId: job.producerId,
    producerName: producerNameOf(job.producerId),
    title: artifact.role === "stem" ? humanize(artifact.fileName.replace(/\.[a-z0-9]+$/i, "")) : sessionTitle(job),
    seconds: artifact.durationSeconds ?? (job.capability === "MUSIC_GENERATION" && job.musicLengthMs ? job.musicLengthMs / 1000 : null),
    format: artifact.fileName.split(".").pop().toUpperCase(),
    providerLabel: artifact.providerId ? providerName(artifact.providerId) : null,
    contentType: artifact.contentType,
    bytes: artifact.bytes,
    jobId: job.jobId,
    artifact,
  }));
}

function emptyState(headline, line) {
  return el("div", { class: "empty-state" }, el("span", { class: "serif" }, headline), line);
}

function sectionTitle(text, extra) {
  return el("div", { class: "section-title" }, el("h2", {}, text), el("span", { class: "rule" }), extra ?? null);
}

// ---------- Sessions ----------

function sessionRow(job) {
  return el("button", {
    class: "session",
    type: "button",
    style: { "--accent": producerTheme(job.producerId).accent },
    onclick: () => { location.hash = `#/sessions/${encodeURIComponent(job.jobId)}`; },
  },
    el("span", { class: "who" }, producerNameOf(job.producerId)),
    el("span", { class: "what" }, sessionTitle(job), el("span", { class: "faint" }, `  ·  ${WORKFLOW_LABELS[job.workflowId] ?? job.workflowId}${job.legacy ? " · legacy" : ""}`)),
    el("span", { class: "state" }, statusLine(job.status)),
    el("span", { class: "when" }, fmtTime(job.createdAt)));
}

function sessionList(jobs, emptyLine = "Bir producer seç ve ilk session'ı hazırla.") {
  if (!jobs.length) return emptyState("No sessions yet.", emptyLine);
  return el("div", { class: "sessions" }, jobs.map(sessionRow));
}

function briefContextPanel(context) {
  if (!context) return el("p", { class: "muted" }, "Bilgi bağlamı yok.");
  const pack = (item, title) => el("details", { class: "disclosure", open: title === "Primary" },
    el("summary", {}, `${title} · ${item.id} · ${item.lineage.join(" › ")}`),
    el("div", { class: "disclosure-body context-pack" },
      el("dl", { class: "kv" }, Object.entries(item.defaults).flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, typeof v === "string" ? v : JSON.stringify(v))])),
      Object.entries(item.traits).map(([trait, values]) => el("div", {}, el("div", { class: "eyebrow" }, trait), el("ul", {}, values.map((v) => el("li", {}, v))))),
      item.avoid.length ? el("div", {}, el("div", { class: "eyebrow" }, "Avoid"), el("ul", {}, item.avoid.map((v) => el("li", {}, v)))) : null,
      item.reviewPriorities.length ? el("div", {}, el("div", { class: "eyebrow" }, "Review priorities"), el("ul", {}, item.reviewPriorities.map((v) => el("li", {}, v)))) : null));
  return el("div", {}, pack(context.primary, "Primary"), context.secondary.map((item) => pack(item, "Secondary")));
}

// Brief editor + free prompt preview + guarded commit. The request contract is unchanged:
// POST /api/jobs/:id/execute with { creativeBrief, confirm: "EXECUTE" } after explicit consent.
function executePanel(job, onDone) {
  const isStems = job.capability === "STEM_SEPARATION";
  const provider = providerFor(job.capability);
  const brief = el("textarea", {
    class: "brief-editor",
    id: `brief-${job.jobId}`,
    rows: 6,
    placeholder: "Concise English production brief: purpose, tempo feel, mood, groove, palette, density, vocal space, what to avoid.",
  }, job.creativeBrief ?? state.briefDrafts[job.jobId] ?? "");
  brief.addEventListener("input", () => { state.briefDrafts[job.jobId] = brief.value; });
  const preview = el("div");
  const status = el("div", { role: "status" });

  async function doPreview() {
    fill(preview, el("p", { class: "muted" }, "Önizleniyor…"));
    try {
      const result = await post(`/api/jobs/${job.jobId}/preview`, { creativeBrief: brief.value });
      fill(preview,
        el("p", { class: "eyebrow", style: { margin: "6px 0 8px" } },
          `Final prompt · ${result.promptChars} karakter · ${result.includedGuidanceCount} bilgi satırı · ${result.omittedGuidanceCount} sığmadı`),
        el("pre", { class: "block-text" }, result.prompt));
    } catch (error) {
      fill(preview, el("div", { class: "notice error" }, error.message));
    }
  }

  function confirmExecute() {
    const creativeBrief = isStems ? "Separate stems from the user-selected track." : brief.value.trim();
    if (!isStems && creativeBrief.length < 10) {
      fill(status, el("div", { class: "notice error" }, "Production brief en az 10 karakter olmalı."));
      brief.focus();
      return;
    }
    const understand = el("input", { type: "checkbox", id: "commit-consent" });
    const go = el("button", { class: "btn btn-commit", type: "button", disabled: true }, "Commit generation");
    understand.addEventListener("change", () => { go.disabled = !understand.checked; });
    go.addEventListener("click", async () => {
      go.disabled = true;
      dialog.close();
      fill(status, el("div", { class: "notice info" }, "Generation başlatıldı. Session durumu otomatik güncellenecek."));
      try {
        await post(`/api/jobs/${job.jobId}/execute`, { creativeBrief, confirm: "EXECUTE" });
        onDone?.();
      } catch (error) {
        fill(status, el("div", { class: "notice error" }, error.message));
      }
    });
    fill(dialog,
      el("div", { class: "eyebrow" }, "Commit generation"),
      el("h2", {}, "Gerçek provider çağrısı"),
      el("p", {}, "Bu session ", el("strong", {}, CAPABILITY_LABELS[job.capability] ?? job.capability), " için Provider Registry'nin seçtiği provider'a gönderilir",
        provider ? [": ", el("strong", {}, provider.displayName)] : " (şu an bağlı provider yok; session waiting_for_provider olur)", "."),
      el("div", { class: "notice" }, "API kredisi veya GPU süresi harcayabilir. Tamamlanan ya da başarısız session tekrar çalıştırılamaz; revizyon için yeni session hazırlanır."),
      el("dl", { class: "kv", style: { margin: "18px 0" } },
        el("dt", {}, "Session"), el("dd", { class: "mono" }, job.jobId),
        el("dt", {}, "Producer"), el("dd", {}, producerNameOf(job.producerId)),
        el("dt", {}, "Workflow"), el("dd", {}, job.workflowId)),
      el("label", { class: "check", for: "commit-consent" }, understand, "Maliyet oluşabileceğini anlıyorum ve bu session'ı çalıştırmak istiyorum."),
      el("div", { class: "actions", style: { "margin-top": "22px" } },
        go,
        el("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Vazgeç")));
    dialog.showModal();
    understand.focus();
  }

  return el("div", { class: "block", style: { "border-top": "0", "padding-top": "0" } },
    isStems
      ? el("p", { class: "muted" }, `Stem separation prompt kullanmaz. Kaynak: ${job.sourcePath ?? "—"}`)
      : [
          el("label", { class: "field", for: `brief-${job.jobId}` },
            el("span", {}, "Production brief"),
            el("small", { class: "muted" }, "Provider-nötr, İngilizce. Producer bunu istek ve bilgi bağlamından yazar; provider adı içermez.")),
          brief,
          el("div", { class: "actions" },
            el("button", { class: "btn", type: "button", onclick: doPreview }, "Final prompt önizle · ücretsiz")),
          preview,
        ],
    el("div", { class: "commit-zone" },
      el("div", { class: "eyebrow" }, "Commit generation"),
      el("p", { class: "muted", style: { margin: 0 } },
        "Gerçek üretim ", provider ? el("strong", {}, provider.displayName) : "bağlı olmayan bir provider", " üzerinden yapılır ve maliyet oluşturabilir. Onay penceresi açılır."),
      el("div", { class: "actions" },
        el("button", { class: "btn btn-commit", type: "button", onclick: confirmExecute }, "Commit generation…"))),
    status);
}

// ---------- Drawer (session detail / Job Monitor) ----------

let drawerReturnFocus = null;

function closeDrawer() {
  fill(drawerRoot);
  document.removeEventListener("keydown", drawerKeys);
  if (location.hash.startsWith("#/sessions/")) history.replaceState(null, "", "#/sessions");
  drawerReturnFocus?.focus?.();
}

function drawerKeys(event) {
  if (event.key === "Escape" && !dialog.open) closeDrawer();
}

function openDrawer(content, label) {
  drawerReturnFocus = document.activeElement;
  const close = el("button", { class: "btn drawer-close", type: "button", onclick: closeDrawer }, "Kapat");
  fill(drawerRoot,
    el("div", { class: "drawer-backdrop", onclick: closeDrawer }),
    el("aside", { class: "drawer", role: "dialog", "aria-modal": "true", "aria-label": label }, close, content));
  document.addEventListener("keydown", drawerKeys);
  close.focus();
}

async function sessionDetail(jobId) {
  const job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
  const running = job.execution?.state === "running" || job.status === "running";
  const takes = artifactTakes(job);
  const refresh = () => renderDrawerSession(jobId);
  return el("div", { style: { display: "grid", gap: "34px", "--accent": producerTheme(job.producerId).accent } },
    el("div", { style: { display: "grid", gap: "10px" } },
      el("div", { class: "eyebrow", style: { color: "var(--accent)" } }, producerNameOf(job.producerId)),
      el("h2", { class: "display", style: { "font-size": "clamp(34px, 5vw, 56px)" } }, sessionTitle(job)),
      el("div", { class: "actions" }, statusLine(job.status), job.legacy ? el("span", { class: "faint" }, "legacy · read-only") : null)),
    signalFlow(job.workflowId, job),
    job.error ? el("div", { class: "notice error" }, job.error) : null,
    job.execution?.state === "failed" && !job.error ? el("div", { class: "notice error" }, job.execution.error) : null,
    takes.length ? el("div", { class: "takes" }, takes.map(takeCard)) : null,
    el("section", { class: "block" },
      el("div", { class: "eyebrow" }, "Request"),
      el("p", { class: "serif", style: { "font-size": "22px", margin: 0 } }, job.userRequest ?? "—")),
    !SHOWCASE && job.executable && !running
      ? el("section", { class: "block" }, el("div", { class: "eyebrow" }, "Next step"), executePanel(job, refresh))
      : null,
    job.creativeBrief ? el("section", { class: "block" }, el("div", { class: "eyebrow" }, "Production brief"), el("pre", { class: "block-text" }, job.creativeBrief)) : null,
    el("section", { class: "block" },
      el("div", { class: "eyebrow" }, "Job Monitor · technical"),
      el("dl", { class: "kv" },
        el("dt", {}, "job_id"), el("dd", { class: "mono" }, job.jobId),
        el("dt", {}, "status"), el("dd", {}, job.status),
        el("dt", {}, "workflow"), el("dd", {}, job.workflowId),
        el("dt", {}, "capability"), el("dd", {}, job.capability),
        el("dt", {}, "provider"), el("dd", {}, job.providerId ?? "—"),
        el("dt", {}, "primary genre"), el("dd", {}, job.primaryGenre),
        el("dt", {}, "secondary"), el("dd", {}, job.secondaryGenres.join(", ") || "—"),
        el("dt", {}, "output name"), el("dd", {}, job.outputName ?? "—"),
        el("dt", {}, "mode"), el("dd", {}, job.capability === "MUSIC_GENERATION" ? `${job.generationMode} · ${job.musicLengthMs / 1000}s` : "—"),
        el("dt", {}, "sample length"), el("dd", {}, job.durationSeconds ? `${job.durationSeconds} s` : "—"),
        el("dt", {}, "negative prompt"), el("dd", {}, job.negativePrompt ?? "—"),
        el("dt", {}, "created"), el("dd", {}, fmtDate(job.createdAt)),
        el("dt", {}, "updated"), el("dd", {}, fmtDate(job.updatedAt))),
      el("div", { class: "eyebrow", style: { "margin-top": "8px" } }, "Lifecycle"),
      el("ol", { class: "timeline" }, job.lifecycle.map((event) => el("li", { class: event.state },
        el("span", { class: "dot" }), el("span", {}, event.label), el("time", {}, event.at ? fmtDate(event.at) : "")))),
      job.finalPrompt
        ? el("details", { class: "disclosure" },
            el("summary", {}, `Final prompt · ${job.finalPrompt.length} karakter · ${job.omittedGuidanceCount ?? 0} satır çıkarıldı`),
            el("div", { class: "disclosure-body" }, el("pre", { class: "block-text" }, job.finalPrompt)))
        : null,
      el("details", { class: "disclosure" },
        el("summary", {}, "brief_context"),
        el("div", { class: "disclosure-body" }, briefContextPanel(job.briefContext)))));
}

async function renderDrawerSession(jobId) {
  try {
    const content = await sessionDetail(jobId);
    const drawer = drawerRoot.querySelector(".drawer");
    if (drawer) drawer.replaceChildren(drawer.firstChild, content);
    else openDrawer(content, "Session");
    player.sync();
  } catch (error) {
    openDrawer(el("div", { class: "notice error" }, error.message), "Session");
  }
}

// ---------- Views ----------

function snowfall() {
  // A handful of slow particles; hidden on small screens and with reduced motion (CSS).
  const flakes = Array.from({ length: 14 }, (_, i) => el("span", {
    class: "flake",
    style: {
      left: `${(i * 37 + 11) % 100}%`,
      "animation-duration": `${18 + (i % 5) * 4}s`,
      "animation-delay": `${-(i * 2.7)}s`,
      "--drift": `${(i % 2 ? 1 : -1) * (10 + (i % 4) * 8)}px`,
      opacity: String(0.3 + (i % 3) * 0.15),
    },
  }));
  return el("div", { class: "flakes", "aria-hidden": "true" }, flakes);
}

function portal(producer, jobs) {
  const theme = producerTheme(producer.producerId);
  const active = jobs.find((job) => job.producerId === producer.producerId && ["prepared", "running"].includes(job.status));
  return el("a", {
    class: "portal",
    href: `#/studio/${producer.producerId}`,
    style: { "--accent": theme.accent, "--accent-glow": theme.glow },
    "aria-label": `${producer.name} — ${theme.world || producer.specialty}. Kimliği incele.`,
  },
    producerVisual(producer, { preference: ["seasonalPortrait", "fullBody", "portrait"], eager: true }),
    el("div", { class: "portal-status" },
      active ? el("span", { class: "status live" }, active.status === "running" ? "Generating" : "In session") : el("span", { class: "status on" }, "Available")),
    el("div", { class: "portal-body" },
      el("div", { class: "eyebrow" }, theme.world || producer.specialty),
      el("h2", { class: "display portal-name" }, producer.name),
      el("div", { class: "portal-more" },
        el("span", { class: "portal-world" }, theme.mood),
        el("span", { class: "faint", style: { "font-size": "12.5px" } }, `${producer.catalog.packCount} genre packs`)),
      el("span", { class: "portal-cta" }, "Kimliği incele")));
}

async function renderLobby() {
  applyProducerAccent(null);
  const [system, jobs] = await Promise.all([loadSystem(), loadJobs()]);
  // Takes need per-job detail requests; the lobby paints first and fills them in after.
  const latestSlot = el("div", {}, el("p", { class: "faint" }, "…"));
  loadTakes().then((takes) => {
    const latest = takes.filter((t) => t.kind !== "stem").slice(0, 3);
    fill(latestSlot, latest.length ? el("div", { class: "takes" }, latest.map(takeCard)) : emptyState("Nothing has been generated yet.", "İlk take bir session commit edildiğinde burada görünür."));
    player.sync();
  }).catch((error) => fill(latestSlot, el("div", { class: "notice error" }, error.message)));
  fill(view,
    el("section", { class: "hero" },
      snowfall(),
      el("div", { class: "eyebrow" }, "Virtual producers"),
      el("h1", { class: "hero-word" }, "AVATAR"),
      el("div", { class: "hero-meta" },
        el("span", { class: "eyebrow" }, SEASON.label),
        el("span", { class: "serif" }, SEASON.title)),
      el("p", { class: "hero-note" }, "Sistemin üç producer kimliği. Her birinin uzmanlığını, bilgi kataloğunu ve çalışmalarını buradan incele; sistemin canlı akışı Live ekranında.")),
    el("section", { class: "portals", "aria-label": "Producers" }, system.producers.map((producer) => portal(producer, jobs))),
    el("div", { class: "lobby-strip" },
      el("section", {},
        sectionTitle("Latest takes", el("a", { href: "#/library", class: "eyebrow" }, "Library")),
        latestSlot),
      el("section", {},
        sectionTitle("Sessions", el("a", { href: "#/sessions", class: "eyebrow" }, "All")),
        sessionList(jobs.slice(0, 5)))),
    el("section", {},
      sectionTitle("System", el("a", { href: "#/system", class: "eyebrow" }, "Backstage")),
      el("div", { class: "actions" }, system.capabilities
        .filter((c) => c.connected || c.usedBy.length)
        .map((c) => el("span", { class: `status ${c.connected ? "on" : ""}` }, `${CAPABILITY_LABELS[c.capability] ?? c.capability} — ${c.connected ? "Online" : "Not connected"}`)))));
  player.sync();
}

const CLASSIFICATION_LABELS = {
  genre: "Kök tür",
  subgenre: "Alt tür",
  regional_style: "Bölgesel stil",
  era_style: "Dönem",
  thematic_style: "Tematik",
  scene: "Sahne",
  umbrella: "Şemsiye",
  production_mode: "Üretim yöntemi",
  fusion: "Füzyon",
};

// The producer's knowledge catalog grouped by classification: what this avatar "knows".
function knowledgeMap(producer) {
  const groups = new Map();
  for (const genre of producer.genres) {
    const key = genre.classification ?? "other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(genre);
  }
  return el("div", { class: "block" },
    el("div", { class: "block-head" },
      el("h3", {}, "Bilgi haritası"),
      el("span", { class: "muted" }, `${producer.catalog.packCount} paket · ${producer.catalog.contentVersion} · ${producer.catalog.reviewStatus}`)),
    el("p", { class: "muted", style: { margin: 0 } }, producer.catalog.domain),
    [...groups.entries()].map(([classification, genres]) => el("div", { class: "kmap-group" },
      el("div", { class: "eyebrow", lang: CLASSIFICATION_LABELS[classification] ? "tr" : "en" }, `${CLASSIFICATION_LABELS[classification] ?? classification} · ${genres.length}`),
      el("div", { class: "kmap" }, genres.map((genre) => el("span", { class: "kmap-item", title: genre.id }, genre.label))))));
}

function studioForm(producer) {
  const pid = producer.producerId;
  const form = state.studio[pid] ??= { format: "track" };
  const format = FORMATS.find((f) => f.id === form.format) ?? FORMATS[0];
  const step = workflowById(format.workflowId)?.steps.find((s) => s.capability === format.capability);
  const bind = (name) => (event) => {
    form[name] = event.target.type === "checkbox" ? event.target.checked : event.target.value;
  };
  const value = (name, fallback = "") => form[name] ?? fallback;
  const rerender = () => fill(document.getElementById("composer"), studioForm(producer));
  const genreList = `genres-${pid}`;
  const output = el("div", { id: "prepare-feedback", role: "status" });

  async function prepare() {
    fill(output, el("p", { class: "muted" }, "Session hazırlanıyor…"));
    try {
      const result = await post("/api/prepare", prepareInput(pid));
      state.sessionByProducer[pid] = result.job_id;
      state.briefDrafts[result.job_id] = form.userRequest ?? "";
      fill(output);
      await refreshSessionBlock(pid);
      document.getElementById("current-session")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      fill(output, el("div", { class: "notice error" }, error.message));
    }
  }

  return el("div", { class: "composer" },
    el("label", { class: "composer-question", for: `request-${pid}` }, "Bugün ne yapıyoruz?"),
    el("textarea", {
      class: "request",
      id: `request-${pid}`,
      rows: 5,
      oninput: bind("userRequest"),
      placeholder: pid === "daniska"
        ? "140 BPM, karanlık ve duygusal bir UK drill beat; rapper'a geniş alan bırak…"
        : pid === "eliska"
          ? "Gece sürüşü hissinde, buzlu synth'li dreamy bir pop hook…"
          : "Gece 3 hissinde, hipnotik ve sıcak bir deep house groove…",
    }, value("userRequest")),
    el("div", { class: "actions" },
      el("div", { class: "segmented", role: "group", "aria-label": "Format" }, FORMATS.map((f) =>
        el("button", { type: "button", "aria-pressed": String(f.id === format.id), onclick: () => { form.format = f.id; rerender(); } }, f.label))),
      step ? stepStatus(step) : null),
    el("div", { class: "fields" },
      el("label", { class: "field" }, el("span", {}, "Genre"),
        el("input", { list: genreList, value: value("primaryGenre"), oninput: bind("primaryGenre"), placeholder: producer.genres[0]?.id, required: true, autocomplete: "off" })),
      el("datalist", { id: genreList }, producer.genres.map((g) => el("option", { value: g.id }, g.label))),
      format.id === "stems"
        ? el("label", { class: "field wide" }, el("span", {}, "Seçilmiş track"),
            el("select", { onchange: bind("sourcePath") },
              el("option", { value: "" }, "— dinleyip seçtiğin track —"),
              (state.trackOptions ?? []).map((t) => el("option", { value: t.path, selected: value("sourcePath") === t.path }, t.fileName))))
        : format.id === "fl"
          ? el("label", { class: "field wide" }, el("span", {}, "Ayrılmış stem session"),
              el("select", { onchange: bind("stemSession") },
                el("option", { value: "" }, "— FL Studio'ya gönderilecek stem grubu —"),
                (state.stemOptions ?? []).map((option) => el("option", {
                  value: option.id,
                  selected: value("stemSession") === option.id,
                }, `${option.label} · ${option.paths.length} stem`))))
          : null),
    el("details", { class: "disclosure" },
      el("summary", {}, "Advanced"),
      el("div", { class: "disclosure-body" },
        el("div", { class: "fields" },
          el("label", { class: "field" }, el("span", {}, "Secondary genres (max 3)"),
            el("input", { value: value("secondaryGenres"), oninput: bind("secondaryGenres"), placeholder: "cloud-rap, trap-soul" })),
          el("label", { class: "field" }, el("span", {}, "Output name"),
            el("input", { value: value("outputName"), oninput: bind("outputName"), maxlength: 64 })),
          format.id === "track" ? [
            el("label", { class: "field" }, el("span", {}, "Mode"),
              el("select", { onchange: bind("generationMode") },
                ["direct", "planned"].map((m) => el("option", { value: m, selected: value("generationMode", "direct") === m }, m)))),
            el("label", { class: "field" }, el("span", {}, "Length (seconds)"),
              el("input", { type: "number", min: 3, max: 600, value: value("musicLengthSeconds", 30), oninput: bind("musicLengthSeconds") })),
            el("label", { class: "check", style: { "align-self": "end", "min-height": "44px" } },
              el("input", { type: "checkbox", checked: form.forceInstrumental ?? true, onchange: bind("forceInstrumental") }), "Instrumental"),
          ] : null,
          format.id === "sample" ? [
            el("label", { class: "field" }, el("span", {}, "Length (seconds)"),
              el("input", { type: "number", min: 1, max: 30, step: 0.01, value: value("durationSeconds", 8), oninput: bind("durationSeconds") })),
            el("label", { class: "field" }, el("span", {}, "Seed"),
              el("input", { type: "number", min: 0, value: value("seed"), oninput: bind("seed") })),
            el("label", { class: "field wide" }, el("span", {}, "Negative prompt"),
              el("input", { value: value("negativePrompt"), oninput: bind("negativePrompt"), placeholder: "drums, bass, vocals" })),
          ] : null,
          format.id === "stems" ? el("label", { class: "field" }, el("span", {}, "Stem layout"),
            el("select", { onchange: bind("stemLayout") },
              [
                ["six_stems", "6 stems · vocals, drums, bass, other, guitar, piano"],
                ["four_stems", "4 stems · vocals, drums, bass, other"],
                ["vocals_instrumental", "2 stems · vocals + instrumental"],
              ].map(([id, label]) => el("option", {
                value: id,
                selected: value("stemLayout", "six_stems") === id,
              }, label)))) : null))),
    el("div", { class: "actions" },
      el("button", { class: "btn btn-prepare", type: "button", onclick: prepare }, "Prepare session"),
      el("span", { class: "muted", style: { "font-size": "13px" } }, "Bilgi paketini çözer ve session'ı kaydeder. Provider çağrısı yok, ücretsiz.")),
    output);
}

function prepareInput(producerId) {
  const form = state.studio[producerId];
  const format = FORMATS.find((f) => f.id === form.format) ?? FORMATS[0];
  const secondary = String(form.secondaryGenres ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const input = {
    workflowId: format.workflowId,
    capability: format.capability,
    producerId,
    userRequest: String(form.userRequest ?? "").trim(),
    primaryGenre: String(form.primaryGenre ?? "").trim(),
    secondaryGenres: secondary,
  };
  if (form.outputName?.trim()) input.outputName = form.outputName.trim();
  if (format.capability === "MUSIC_GENERATION") {
    input.generationMode = form.generationMode || "direct";
    input.musicLengthMs = Math.round(Number(form.musicLengthSeconds || 30) * 1000);
    input.forceInstrumental = form.forceInstrumental ?? true;
  }
  if (format.capability === "SAMPLE_GENERATION") {
    input.durationSeconds = Number(form.durationSeconds || 8);
    if (form.negativePrompt?.trim()) input.negativePrompt = form.negativePrompt.trim();
    if (String(form.seed ?? "").trim()) input.seed = Number(form.seed);
  }
  if (format.capability === "STEM_SEPARATION") {
    if (form.sourcePath) input.sourcePath = form.sourcePath;
    input.stemLayout = form.stemLayout || "six_stems";
  }
  if (format.capability === "DAW_CONTROL") {
    const selected = (state.stemOptions ?? []).find((option) => option.id === form.stemSession);
    if (selected) {
      input.sourcePaths = selected.paths;
      input.stemLabels = selected.labels;
      input.projectName = form.outputName?.trim() || selected.label;
    }
  }
  return input;
}

async function refreshSessionBlock(producerId) {
  const block = document.getElementById("current-session");
  const jobId = state.sessionByProducer[producerId];
  if (!block) return;
  if (!jobId) {
    fill(block);
    return;
  }
  const job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
  const running = job.execution?.state === "running" || job.status === "running";
  fill(block,
    el("div", { class: "block-head" },
      el("h3", {}, "Current session"),
      statusLine(job.status),
      el("span", { class: "spacer" }),
      el("a", { href: `#/sessions/${encodeURIComponent(job.jobId)}`, class: "eyebrow" }, "Details")),
    el("p", { class: "muted", style: { margin: 0 } }, sessionTitle(job), " · ", WORKFLOW_LABELS[job.workflowId]),
    signalFlow(job.workflowId, job),
    job.error ? el("div", { class: "notice error" }, job.error) : null,
    job.artifacts.length ? el("div", { class: "takes" }, artifactTakes(job).map(takeCard)) : null,
    !SHOWCASE && job.executable && !running ? executePanel(job, () => refreshSessionBlock(producerId)) : null,
    el("details", { class: "disclosure" },
      el("summary", {}, "Producer context · brief_context"),
      el("div", { class: "disclosure-body" }, briefContextPanel(job.briefContext))));
  player.sync();
}

async function renderStudio(producerId) {
  await loadSystem();
  const producer = producerById(producerId);
  if (!producer) return renderLobby();
  applyProducerAccent(producerId);
  const theme = producerTheme(producerId);
  const jobs = await loadJobs();
  const takes = await loadTakes();
  state.trackOptions = takes.filter((t) => t.kind === "track");
  const stemGroups = new Map();
  for (const take of takes.filter((item) => item.kind === "stem")) {
    const id = take.jobId ?? take.group;
    if (!id) continue;
    const group = stemGroups.get(id) ?? {
      id,
      label: take.group || take.title || id,
      paths: [],
      labels: [],
    };
    group.paths.push(take.path);
    group.labels.push(take.fileName.replace(/\.[a-z0-9]+$/i, ""));
    stemGroups.set(id, group);
  }
  state.stemOptions = [...stemGroups.values()];
  const mine = jobs.filter((job) => job.producerId === producerId);
  const myTakes = takes.filter((t) => t.producerId === producerId && t.kind !== "stem");

  fill(view,
    el("div", { class: "studio" },
      el("aside", { class: "studio-figure" },
        producerVisual(producer, { preference: ["fullBody", "seasonalPortrait", "portrait"], eager: true, sizes: "(max-width: 1080px) 180px, 40vw" }),
        el("div", {},
          el("div", { class: "eyebrow", style: { "margin-top": "18px" } }, `${producer.name} studio · ${SEASON.label}`),
          el("h1", { class: "display studio-name" }, producer.name),
          el("p", { class: "muted" }, theme.world || producer.specialty),
          el("p", { class: "faint", style: { "font-size": "13px" } }, `${producer.catalog.packCount} genre packs · catalog ${producer.catalog.reviewStatus}`))),
      el("div", { class: "studio-main" },
        SHOWCASE
          ? el("section", { class: "block agent-panel" },
              el("div", { class: "notice info" },
                `Vitrin modu: Bu sayfa Avatar v2'nin gerçek kayıtlarından alınmış salt-okunur bir anlık görüntüdür. ${producer.name} ile konuşma ve üretim yalnız yerel kurulumda çalışır; buradaki session'lar ve take'ler o kurulumda üretildi.`))
          : el("section", { id: "agent-panel", class: "block agent-panel" }),
        el("section", {}, knowledgeMap(producer)),
        SHOWCASE ? null : el("details", { class: "disclosure bench" },
          el("summary", {}, "Test tezgâhı · manuel prepare / commit"),
          el("div", { class: "disclosure-body" },
            el("p", { class: "muted", style: { margin: 0 } },
              "Normalde bu adımları LLM, producer kimliğiyle MCP üzerinden yapar. Burası sistemi elle denemek içindir: Prepare ücretsizdir, Commit gerçek provider çağrısı yapar."),
            el("section", { id: "composer" }, studioForm(producer)))),
        el("section", { id: "current-session", class: "block", "aria-live": "polite" }),
        el("section", {},
          sectionTitle("Takes"),
          myTakes.length ? el("div", { class: "takes" }, myTakes.slice(0, 6).map(takeCard))
            : emptyState("Nothing has been generated in this studio yet.", "İlk session'ı hazırla ve commit et.")),
        el("section", {},
          sectionTitle("Sessions"),
          sessionList(mine.slice(0, 6), `${producer.name} için henüz session yok.`)))));
  if (!state.sessionByProducer[producerId]) {
    const open = mine.find((job) => ["prepared", "running", "waiting_for_provider", "awaiting_daw_import"].includes(job.status));
    if (open) state.sessionByProducer[producerId] = open.jobId;
  }
  await Promise.all([refreshSessionBlock(producerId), SHOWCASE ? null : renderAgentPanel(producer)]);
  player.sync();
}

async function renderSessions(jobId) {
  applyProducerAccent(null);
  await loadSystem();
  const jobs = await loadJobs();
  const filter = state.sessionFilter;
  const filtered = filter === "all" ? jobs : jobs.filter((job) => job.status === filter);
  const statuses = ["all", "prepared", "running", "waiting_for_provider", "awaiting_daw_import", "completed", "failed"];
  fill(view,
    el("section", { class: "hero", style: { "padding-bottom": "28px" } },
      el("div", { class: "eyebrow" }, "Job Monitor"),
      el("h1", { class: "display", style: { "font-size": "clamp(48px, 8vw, 110px)" } }, "Sessions"),
      el("p", { class: "hero-note" }, "Her session bir hazırlanmış job'dır. Detayda teknik kayıt, yaşam döngüsü ve çıktılar yer alır.")),
    el("div", { class: "filters", role: "group", "aria-label": "Durum filtresi" }, statuses.map((status) =>
      el("button", { type: "button", "aria-pressed": String(status === filter), onclick: () => { state.sessionFilter = status; renderSessions(); } },
        `${status === "all" ? "All" : status.replaceAll("_", " ")} · ${status === "all" ? jobs.length : jobs.filter((j) => j.status === status).length}`))),
    sessionList(filtered, filter === "all" ? "Bir producer seç ve ilk session'ı hazırla." : "Bu durumda session yok."));
  if (jobId) await renderDrawerSession(jobId);
  else if (drawerRoot.childElementCount) fill(drawerRoot);
}

async function renderLibrary() {
  applyProducerAccent(null);
  await loadSystem();
  const takes = await loadTakes();
  const filters = [
    { id: "all", label: "All", test: () => true },
    ...state.system.producers.map((p) => ({ id: p.producerId, label: p.name, test: (t) => t.producerId === p.producerId })),
    { id: "track", label: "Tracks", test: (t) => t.kind === "track" },
    { id: "sample", label: "Samples", test: (t) => t.kind === "sample" },
    { id: "stem", label: "Stems", test: (t) => t.kind === "stem" },
  ];
  const active = filters.find((f) => f.id === state.libraryFilter) ?? filters[0];
  const visible = takes.filter(active.test);
  fill(view,
    el("section", { class: "hero", style: { "padding-bottom": "28px" } },
      el("div", { class: "eyebrow" }, "Outputs"),
      el("h1", { class: "display", style: { "font-size": "clamp(48px, 8vw, 110px)" } }, "Library"),
      el("p", { class: "hero-note" }, SHOWCASE
        ? "Yerel kurulumda gerçekten üretilmiş parçalardan seçilmiş bir bölüm. Her take, Sessions'taki job kaydına bağlıdır."
        : "outputs/ altındaki gerçek dosyalar. Çalma ve indirme yalnız kontrollü media route'u üzerinden yapılır.")),
    el("div", { class: "filters", role: "group", "aria-label": "Library filtresi" }, filters.map((f) =>
      el("button", { type: "button", "aria-pressed": String(f.id === active.id), onclick: () => { state.libraryFilter = f.id; renderLibrary(); } },
        `${f.label} · ${takes.filter(f.test).length}`))),
    visible.length ? el("div", { class: "takes" }, visible.map(takeCard)) : emptyState("Nothing here yet.", "Bu filtrede henüz çıktı yok."));
  player.sync();
}

async function renderSystem() {
  applyProducerAccent(null);
  const [system, jobs] = await Promise.all([loadSystem(), loadJobs()]);
  const latestByWorkflow = (workflowId) => jobs.find((job) => job.workflowId === workflowId) ?? null;
  fill(view,
    el("section", { class: "hero", style: { "padding-bottom": "28px" } },
      el("div", { class: "eyebrow" }, "Backstage"),
      el("h1", { class: "display", style: { "font-size": "clamp(48px, 8vw, 110px)" } }, "System"),
      el("p", { class: "hero-note" }, SHOWCASE
        ? `Provider Registry'nin anlık görüntü alındığı andaki durumu (${fmtDate(system.snapshotAt)}). "Online", o an yerel kurulumda bağlı olduğu anlamına gelir; bu sayfadan hiçbir provider çağrılmaz.`
        : "Provider Registry'den okunan gerçek durum. Secret değerleri tarayıcıya gönderilmez; yalnız yapılandırılıp yapılandırılmadığı görünür.")),
    el("div", { class: "backstage" },
      el("section", {},
        el("div", { class: "eyebrow", style: { "margin-bottom": "12px" } }, "Capabilities"),
        el("ul", { class: "syslist" }, system.capabilities.map((c) => el("li", {},
          el("span", {}, CAPABILITY_LABELS[c.capability] ?? c.capability, el("span", { class: "faint mono" }, `  ${c.capability}`)),
          el("span", { class: `status ${c.connected ? "on" : ""}` }, c.connected ? "Online" : "Not connected"),
          el("span", { class: "sub" }, [c.providers.join(", ") || "no provider", c.usedBy.length ? ` · ${c.usedBy.map((w) => WORKFLOW_LABELS[w]).join(", ")}` : ""]))))),
      el("section", {},
        el("div", { class: "eyebrow", style: { "margin-bottom": "12px" } }, "Providers"),
        el("ul", { class: "syslist" }, system.providers.map((p) => el("li", {},
          el("span", {}, p.displayName),
          el("span", { class: `status ${p.enabled ? "on" : ""}` }, p.enabled ? "Enabled" : "Disabled"),
          el("span", { class: "sub" }, [
            el("span", { class: "mono" }, p.providerId), ` · ${p.capability} · priority ${p.priority} · credentials `,
            p.credentialsConfigured === null ? "—" : p.credentialsConfigured ? "configured" : "missing",
            ` · model ${p.lastReportedModel ?? "henüz raporlanmadı"}`,
          ])))))),
    system.workflows.map((workflow) => el("section", {},
      sectionTitle(WORKFLOW_LABELS[workflow.workflowId], el("span", { class: "eyebrow mono" }, workflow.workflowId)),
      el("p", { class: "muted", style: { "margin-top": 0 } }, workflow.description,
        latestByWorkflow(workflow.workflowId) ? [" · son session: ", el("a", { href: `#/sessions/${encodeURIComponent(latestByWorkflow(workflow.workflowId).jobId)}` }, sessionTitle(latestByWorkflow(workflow.workflowId)))] : null),
      signalFlow(workflow.workflowId, latestByWorkflow(workflow.workflowId)),
      el("ul", { class: "syslist", style: { "margin-top": "22px" } }, workflow.steps.map((step) => el("li", {},
        el("span", {}, CAPABILITY_LABELS[step.capability] ?? step.capability, el("span", { class: "faint mono" }, `  ${step.id}${step.required ? "" : " · optional"}`)),
        stepStatus(step),
        el("span", { class: "sub" }, step.providers.map((p) => p.displayName).join(", ") || "no provider")))))));
}

// ---------- Production Facility (replaces the old Live screen) ----------

function fmtClockTime(iso) {
  const d = new Date(iso);
  return `${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} sn`;
  return `${Math.floor(s / 60)} dk ${Math.round(s % 60)} sn`;
}

function tickTimers() {
  for (const node of document.querySelectorAll("[data-since]")) {
    node.textContent = fmtDuration(Date.now() - new Date(node.dataset.since));
  }
}
setInterval(tickTimers, 1000);

const facility = createFacility({
  showcase: SHOWCASE,
  el,
  fill,
  api,
  player,
  takeCard,
  artifactTakes,
  briefContextPanel,
  producerTheme,
  producerName: (id) => (id ? producerNameOf(id) : null),
  fmtClockTime,
  fmtDuration,
  fmtBytes,
  fmtTime,
  fmtDate,
  tickTimers,
});

async function renderFacility() {
  applyProducerAccent(null);
  await loadSystem();
  await facility.render(view);
}

function onTrace(events) {
  facility.onTrace(events);
}

// ---------- Producer agent (Codex runtime through /api/agent) ----------

state.agent = { info: null, conversation: null, list: [], producerId: null, jobs: {} };

async function loadAgentInfo() {
  if (!state.agent.info) state.agent.info = await api("/api/agent");
  return state.agent.info;
}

function agentEntryKey(entry) {
  return entry.itemId ? `${entry.kind}:${entry.itemId}` : `${entry.kind}:${entry.at}`;
}

function toolSummary(entry) {
  const args = entry.arguments ?? {};
  const result = entry.result ?? {};
  if (entry.tool === "producer_prepare") {
    const target = [args.workflow_id, args.capability, args.primary_genre].filter(Boolean).join(" · ");
    return result.job_id ? `${target} → job ${result.job_id}` : target;
  }
  if (entry.tool === "producer_execute") {
    if (result.status === "awaiting_user_approval") return "stüdyo onayı bekleniyor";
    if (result.ok) return `tamamlandı · ${result.provider_id ?? ""}`;
    return args.job_path ?? "";
  }
  return Object.keys(args).join(", ");
}

async function agentJob(jobId) {
  if (!state.agent.jobs[jobId]) state.agent.jobs[jobId] = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
  return state.agent.jobs[jobId];
}

function approvalCard(entry, conversation) {
  const pending = conversation.pendingApproval?.jobId === entry.jobId;
  const holder = el("div", { class: "commit-zone" },
    el("div", { class: "eyebrow" }, "Commit generation · onay gerekiyor"),
    el("p", { class: "muted", style: { margin: 0 } }, `${producerNameOf(conversation.producerId)} bu brief ile üretim yapmak istiyor (job ${entry.jobId}).`),
    el("pre", { class: "block-text" }, entry.creativeBrief),
    pending
      ? el("div", { class: "actions" },
          el("button", { class: "btn btn-commit", type: "button", onclick: () => confirmAgentApproval(conversation, entry) }, "Onayla ve üret…"),
          el("span", { class: "muted", style: { "font-size": "13px" } }, "Onaylamazsan hiçbir ücretli çağrı yapılmaz."))
      : el("span", { class: "status on" }, "Bu istek için onay artık beklenmiyor"));
  // Provider name comes from the real job's capability and the registry.
  agentJob(entry.jobId).then((job) => {
    const provider = providerFor(job.capability);
    holder.querySelector(".muted").append(` Registry'nin seçeceği provider: ${provider?.displayName ?? "bağlı değil"}.`);
  }).catch(() => {});
  return holder;
}

function confirmAgentApproval(conversation, entry) {
  const understand = el("input", { type: "checkbox", id: "agent-consent" });
  const go = el("button", { class: "btn btn-commit", type: "button", disabled: true }, "Onayla ve üret");
  understand.addEventListener("change", () => { go.disabled = !understand.checked; });
  go.addEventListener("click", async () => {
    go.disabled = true;
    dialog.close();
    try {
      state.agent.conversation = await post(`/api/agent/conversations/${conversation.id}/approve`, { jobId: entry.jobId, confirm: "EXECUTE" });
      renderAgentLog();
    } catch (error) {
      fill(document.getElementById("agent-feedback"), el("div", { class: "notice error" }, error.message));
    }
  });
  fill(dialog,
    el("div", { class: "eyebrow" }, "Commit generation"),
    el("h2", {}, "Gerçek provider çağrısı"),
    el("p", {}, `Onay verirsen ${producerNameOf(conversation.producerId)}, bu brief'i producer_execute ile gönderir. Provider'ı Provider Registry seçer.`),
    el("div", { class: "notice" }, "API kredisi veya GPU süresi harcayabilir. Onay yalnız bu job ve bu brief için, tek seferliktir."),
    el("pre", { class: "block-text", style: { margin: "14px 0" } }, entry.creativeBrief),
    el("label", { class: "check", for: "agent-consent" }, understand, "Maliyet oluşabileceğini anlıyorum ve bu üretimi onaylıyorum."),
    el("div", { class: "actions", style: { "margin-top": "22px" } }, go, el("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Vazgeç")));
  dialog.showModal();
  understand.focus();
}

// Minimal, safe rendering of the agent's markdown: **bold**, `code` and > quotes. Text nodes only.
function renderAgentText(text) {
  return el("div", { class: "log-text" }, String(text).split("\n").map((line) => {
    const quote = line.startsWith("> ");
    const parts = (quote ? line.slice(2) : line).split(/(\*\*[^*]+\*\*|`[^`]+`)/).filter(Boolean).map((part) => {
      if (part.startsWith("**") && part.endsWith("**")) return el("strong", {}, part.slice(2, -2));
      if (part.startsWith("`") && part.endsWith("`")) return el("code", { class: "mono" }, part.slice(1, -1));
      return part;
    });
    return el(quote ? "blockquote" : "div", { class: quote ? "log-quote" : null }, parts.length ? parts : "\u00a0");
  }));
}

function renderAgentEntry(entry, conversation) {
  const producerName = producerNameOf(conversation.producerId);
  switch (entry.kind) {
    case "user":
      return el("li", { class: `log-user ${entry.system ? "log-system" : ""}` },
        el("div", { class: "eyebrow" }, entry.system ? "Sen · onay mesajı" : "Sen"),
        el("p", { class: entry.system ? "muted" : "serif" }, entry.system ? entry.text : `“${entry.text}”`));
    case "agent":
      return el("li", { class: "log-agent" },
        el("div", { class: "eyebrow log-producer" }, producerName),
        renderAgentText(entry.text));
    case "thought":
      return el("li", { class: "log-quiet" },
        el("details", {}, el("summary", {}, `${producerName} düşünüyor`), el("p", { class: "muted" }, entry.text)));
    case "command":
      return el("li", { class: "log-quiet" },
        el("span", { class: "eyebrow" }, "Okudu / çalıştırdı"),
        el("code", { class: "mono" }, entry.command));
    case "tool": {
      const done = entry.status === "completed";
      const failed = entry.status === "failed" || entry.error;
      return el("li", { class: `log-tool ${failed ? "failed" : done ? "done" : "active"}` },
        el("span", { class: "rack-jack", "aria-hidden": "true" }),
        el("div", {},
          el("div", {}, el("span", { class: "mono" }, `${entry.server} · ${entry.tool}`), " ", el("span", { class: `status ${failed ? "fail" : done ? "on" : "live"}` }, failed ? "hata" : done ? "tamam" : "çalışıyor")),
          el("div", { class: "rack-detail" }, failed ? String(entry.error ?? "") : toolSummary(entry))));
    }
    case "job":
      return el("li", { class: "log-quiet" },
        el("span", { class: "eyebrow" }, "Job"),
        el("span", {}, `${entry.jobId} · ${entry.status}${entry.capability ? ` · ${entry.capability}` : ""}${entry.primaryGenre ? ` · ${entry.primaryGenre}` : ""}  `),
        el("a", { href: "#/live" }, "Live'da izle"), " · ",
        el("a", { href: `#/sessions/${encodeURIComponent(entry.jobId)}` }, "Job kaydı"));
    case "approval_required":
      return el("li", {}, approvalCard(entry, conversation));
    case "approval":
      return el("li", { class: "log-quiet" }, el("span", { class: "status on" }, `Onay verildi · ${entry.jobId}`));
    case "artifact": {
      const holder = el("li", { class: "log-artifact" }, el("div", { class: "eyebrow" }, "Gelen ses"));
      agentJob(entry.jobId)
        .then((job) => holder.append(el("div", { class: "takes" }, artifactTakes(job).map(takeCard))))
        .then(() => player.sync())
        .catch((error) => holder.append(el("div", { class: "notice error" }, error.message)));
      return holder;
    }
    case "error":
      return el("li", {}, el("div", { class: "notice error" }, entry.error));
    case "turn":
      return entry.state === "failed" || entry.state === "cancelled"
        ? el("li", { class: "log-quiet" }, el("span", { class: "faint" }, entry.state === "cancelled" ? "Durduruldu." : "Bu tur tamamlanamadı."))
        : null;
    default:
      return null;
  }
}

function runtimeInfo(id) {
  return state.agent.info?.runtimes.find((entry) => entry.runtime === id) ?? null;
}

// An open conversation keeps the runtime it started with; the toggle picks one for new ones.
function activeRuntimeId() {
  return state.agent.conversation?.runtime ?? state.agent.runtime ?? state.agent.info?.defaultRuntime ?? "codex";
}

function renderRuntimeChrome() {
  const id = activeRuntimeId();
  const info = runtimeInfo(id);
  const label = document.getElementById("agent-runtime-label");
  if (label) {
    label.textContent = info
      ? `${info.label} · ${info.model ?? "varsayılan model"}${info.reasoningEffort ? ` · ${info.reasoningEffort}` : ""}`
      : id;
  }
  for (const button of document.querySelectorAll("#agent-runtime button")) {
    button.setAttribute("aria-pressed", String(button.dataset.runtime === id));
  }
  const notice = document.getElementById("agent-runtime-notice");
  if (!notice) return;
  if (!info?.available) {
    fill(notice, el("div", { class: "notice error" }, `${info?.label ?? id} bu makinede bulunamadı.`));
  } else if (info.runtime === "claude" && info.auth === "missing") {
    fill(notice, el("div", { class: "notice" },
      el("p", { style: { margin: "0 0 8px" } }, "Claude, arka planda çalışırken Claude uygulamasının oturumunu kullanamıyor; bir kez giriş anahtarı gerekiyor. Bir terminalde şunu çalıştır:"),
      el("pre", { class: "block-text" }, `& "${info.cliPath}" setup-token`),
      el("p", { style: { margin: "8px 0 0" } }, "Çıkan token'ı proje kökündeki .env dosyasına CLAUDE_CODE_OAUTH_TOKEN=... satırı olarak ekle ve sayfayı yenile. Token tarayıcıya hiçbir zaman gönderilmez.")));
  } else {
    fill(notice);
  }
}

function renderAgentLog() {
  const log = document.getElementById("agent-log");
  const conversation = state.agent.conversation;
  if (!log) return;
  const running = conversation?.status === "running";
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  if (!conversation || !conversation.entries.length) {
    fill(log, el("li", { class: "log-quiet" }, el("span", { class: "muted" },
      `${producerNameOf(state.agent.producerId)}'ya ne yapmak istediğini anlat. Mesaj, seçili agent runtime'ında (${runtimeInfo(activeRuntimeId())?.label ?? "Codex"}) aynı producer rolüne, kurallara ve araçlara gider.`)));
  } else {
    fill(log, conversation.entries.map((entry) => renderAgentEntry(entry, conversation)));
  }
  const lastTurn = conversation?.entries.filter((e) => e.kind === "turn" && e.state === "started").at(-1);
  fill(document.getElementById("agent-status"),
    running
      ? [el("span", { class: "status live" }, `${producerNameOf(state.agent.producerId)} çalışıyor`), el("span", { class: "faint", "data-since": lastTurn?.at ?? new Date().toISOString() }, "")]
      : el("span", { class: "status on" }, "Hazır"));
  const send = document.getElementById("agent-send");
  const stop = document.getElementById("agent-stop");
  if (send) send.disabled = running || !runtimeInfo(activeRuntimeId())?.available;
  renderRuntimeChrome();
  if (stop) stop.hidden = !running;
  if (stick) log.scrollTop = log.scrollHeight;
  tickTimers();
  player.sync();
}

async function openConversation(id) {
  state.agent.conversation = id ? await api(`/api/agent/conversations/${encodeURIComponent(id)}`) : null;
  state.agent.jobs = {};
  try {
    if (id) localStorage.setItem(`avatar-agent-${state.agent.producerId}`, id);
  } catch {
    // Remembering the last conversation is only a convenience.
  }
  renderAgentLog();
}

async function sendAgentMessage(textarea) {
  const text = textarea.value.trim();
  const feedback = document.getElementById("agent-feedback");
  if (!text) return;
  fill(feedback);
  try {
    if (!state.agent.conversation) {
      state.agent.conversation = await post("/api/agent/conversations", { producerId: state.agent.producerId, runtime: activeRuntimeId() });
      const select = document.getElementById("agent-conversation");
      if (select) {
        const label = `${runtimeInfo(state.agent.conversation.runtime)?.label ?? state.agent.conversation.runtime} · ${text.slice(0, 44)}`;
        select.add(el("option", { value: state.agent.conversation.id }, label), 1);
        select.value = state.agent.conversation.id;
      }
      try {
        localStorage.setItem(`avatar-agent-${state.agent.producerId}`, state.agent.conversation.id);
      } catch {
        // ignore storage failures
      }
    }
    state.agent.conversation = await post(`/api/agent/conversations/${state.agent.conversation.id}/messages`, { text });
    textarea.value = "";
    renderAgentLog();
  } catch (error) {
    fill(feedback, el("div", { class: "notice error" }, error.message));
  }
}

async function renderAgentPanel(producer) {
  const panel = document.getElementById("agent-panel");
  if (!panel) return;
  state.agent.producerId = producer.producerId;
  const [info, { conversations }] = await Promise.all([loadAgentInfo(), api(`/api/agent/conversations?producer=${producer.producerId}`)]);
  state.agent.list = conversations;
  let remembered = null;
  try {
    remembered = localStorage.getItem(`avatar-agent-${producer.producerId}`);
  } catch {
    remembered = null;
  }
  const initial = conversations.find((c) => c.id === remembered) ?? null;
  try {
    state.agent.runtime = localStorage.getItem("avatar-agent-runtime") ?? info.defaultRuntime;
  } catch {
    state.agent.runtime = info.defaultRuntime;
  }
  const pickRuntime = (runtimeId) => {
    state.agent.runtime = runtimeId;
    try {
      localStorage.setItem("avatar-agent-runtime", runtimeId);
    } catch {
      // preference only
    }
    // A different runtime cannot continue another runtime's thread: start a new conversation.
    if (state.agent.conversation && state.agent.conversation.runtime !== runtimeId) {
      const select = document.getElementById("agent-conversation");
      if (select) select.value = "";
      void openConversation(null);
    } else {
      renderAgentLog();
    }
  };

  const textarea = el("textarea", {
    class: "request",
    id: "agent-input",
    rows: 4,
    placeholder: `${producer.name}'ya ne yapmak istediğini anlat… (Ctrl+Enter ile gönder)`,
    onkeydown: (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void sendAgentMessage(textarea);
      }
    },
  });
  fill(panel,
    el("div", { class: "block-head" },
      el("h3", {}, `${producer.name} ile çalış`),
      el("span", { class: "faint", id: "agent-runtime-label", style: { "font-size": "12.5px" } }),
      el("span", { class: "spacer" }),
      el("span", { id: "agent-status" })),
    el("div", { id: "agent-runtime-notice" }),
    el("div", { class: "actions" },
      el("div", { class: "segmented", id: "agent-runtime", role: "group", "aria-label": "Agent runtime" },
        info.runtimes.map((entry) => el("button", {
          type: "button",
          "data-runtime": entry.runtime,
          "aria-pressed": "false",
          onclick: () => pickRuntime(entry.runtime),
        }, entry.label))),
      el("select", {
        id: "agent-conversation",
        "aria-label": "Konuşma",
        style: { width: "auto", "min-width": "220px" },
        onchange: (event) => void openConversation(event.target.value || null),
      },
        el("option", { value: "" }, "Yeni konuşma"),
        conversations.map((c) => el("option", { value: c.id, selected: c.id === initial?.id }, `${runtimeInfo(c.runtime)?.label ?? c.runtime} · ${(c.title ?? "Konuşma").slice(0, 44)} · ${fmtTime(c.updatedAt)}`)))),
    el("ol", { class: "agent-log", id: "agent-log", "aria-live": "polite" }),
    el("label", { class: "composer-question", for: "agent-input" }, "Bugün ne yapıyoruz?"),
    textarea,
    el("div", { class: "actions" },
      el("button", { class: "btn btn-prepare", id: "agent-send", type: "button", onclick: () => void sendAgentMessage(textarea) }, `${producer.name}'ya gönder`),
      el("button", {
        class: "btn",
        id: "agent-stop",
        type: "button",
        hidden: true,
        onclick: async () => {
          if (state.agent.conversation) state.agent.conversation = await post(`/api/agent/conversations/${state.agent.conversation.id}/cancel`, {});
        },
      }, "Durdur"),
      el("span", { class: "muted", style: { "font-size": "13px" } }, "Mesaj gönderince ücretli üretim başlamaz; üretim için ayrıca onay istenir.")),
    el("div", { id: "agent-feedback", role: "status" }));
  await openConversation(initial?.id ?? null);
}

function onAgentEvent({ conversationId, entry, status }) {
  const conversation = state.agent.conversation;
  if (!conversation || conversation.id !== conversationId) return;
  conversation.status = status;
  const key = agentEntryKey(entry);
  const index = conversation.entries.findIndex((existing) => agentEntryKey(existing) === key);
  if (index >= 0) conversation.entries[index] = entry;
  else conversation.entries.push(entry);
  if (entry.kind === "approval_required") conversation.pendingApproval = entry;
  if (entry.kind === "approval" || entry.kind === "artifact") conversation.pendingApproval = null;
  if (entry.kind === "artifact") delete state.agent.jobs[entry.jobId];
  if (currentRoute().name === "studio") renderAgentLog();
}

// ---------- Router & live updates ----------

// Old route names stay valid so existing links keep working.
const ALIASES = { facility: "live", dashboard: "live", playground: "studio", workflows: "system", providers: "system", jobs: "sessions", outputs: "library" };

function currentRoute() {
  const [, rawName = "live", param] = location.hash.split("/");
  const name = ALIASES[rawName] ?? rawName;
  return {
    name: ["live", "studio", "sessions", "library", "system"].includes(name) ? name : "live",
    param: param ? decodeURIComponent(param) : null,
  };
}

function updateChrome(name, param) {
  for (const link of document.querySelectorAll("#nav a")) {
    const active = link.dataset.route === name;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const wordmark = document.getElementById("wordmark");
  const producer = name === "studio" && param ? producerById(param) : null;
  fill(wordmark, "AVATAR", producer ? el("span", { class: "identity" }, `/ ${producer.name.toUpperCase()}`) : null);
}

async function renderRoute() {
  const { name, param } = currentRoute();
  if (name !== "sessions") fill(drawerRoot);
  try {
    if (name === "live") await renderFacility();
    else if (name === "studio") await (param ? renderStudio(param) : renderLobby());
    else if (name === "sessions") await renderSessions(param);
    else if (name === "library") await renderLibrary();
    else await renderSystem();
    updateChrome(name, param);
  } catch (error) {
    fill(view, el("div", { class: "notice error", style: { "margin-top": "40px" } }, error.message));
  }
}

function isEditing() {
  return document.activeElement?.matches("textarea, input, select");
}

// Job file changes refresh what is on screen without discarding what the user is typing.
async function onJobsChanged() {
  if (dialog.open) return;
  const { name, param } = currentRoute();
  if (name === "studio" && param) {
    if (!isEditing()) await refreshSessionBlock(param);
    return;
  }
  if (name === "sessions" && param) {
    if (!isEditing()) await renderDrawerSession(param);
    return;
  }
  if (!isEditing() && name !== "library" && name !== "live") await renderRoute();
}

function connectEvents() {
  const conn = document.getElementById("conn");
  if (SHOWCASE) {
    conn.setAttribute("aria-label", "Anlık görüntü");
    return;
  }
  const source = new EventSource("/api/events");
  source.addEventListener("hello", (event) => {
    const { bootId } = JSON.parse(event.data);
    if (state.bootId && state.bootId !== bootId) location.reload();
    state.bootId = bootId;
    conn.classList.add("on");
    conn.setAttribute("aria-label", "Canlı bağlantı");
  });
  source.addEventListener("reload", () => location.reload());
  source.addEventListener("jobs", () => void onJobsChanged());
  source.addEventListener("trace", (event) => onTrace(JSON.parse(event.data).events ?? []));
  source.addEventListener("agent", (event) => onAgentEvent(JSON.parse(event.data)));
  source.onerror = () => {
    conn.classList.remove("on");
    conn.setAttribute("aria-label", "Yeniden bağlanıyor");
  };
}

applySeason();
document.getElementById("season-label").textContent = SHOWCASE ? `${SEASON.label} · Showcase` : SEASON.label;
window.addEventListener("hashchange", renderRoute);
connectEvents();
renderRoute();
