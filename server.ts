// Ollama Cockpit - local telemetry server.
// Polls the Ollama API, the llama-server runner's /slots, nvidia-smi and the PowerShell
// sampler, tails Ollama's server.log for the load layout and exact per-request timings,
// integrates CPU/GPU power into energy, and streams one merged snapshot to the HUD over SSE.
// Run: deno run --allow-net --allow-read --allow-run --allow-env --allow-sys --allow-write server.ts [--open] [--lan]
// --lan also listens on the local network; other devices need the access key in .cockpit-key
// (the dashboard's 手机 button shows a QR code that carries it).

const HERE = new URL(".", import.meta.url);
const BASE_PORT = Number(Deno.env.get("COCKPIT_PORT") ?? 8765);
const LAN = Deno.args.includes("--lan") || Deno.env.get("COCKPIT_LAN") === "1";
const OLLAMA = normalizeHost(Deno.env.get("OLLAMA_HOST") ?? "127.0.0.1:11434");
const LOG_PATH = Deno.env.get("OLLAMA_LOG") ?? `${Deno.env.get("LOCALAPPDATA") ?? ""}\\Ollama\\server.log`;
const PUSH_MS = 250;
const SLOT_POLL_MS = 200;
const HISTORY_LEN = 600;

function normalizeHost(h: string): string {
  let s = h.trim();
  if (!/^https?:\/\//.test(s)) s = "http://" + s;
  const u = new URL(s);
  if (u.hostname === "0.0.0.0" || u.hostname === "[::]") u.hostname = "127.0.0.1";
  if (!u.port) u.port = "11434";
  return u.origin;
}

// ---------- shared state ----------

type Json = Record<string, unknown>;

const state = {
  link: { ok: false, version: null as string | null, err: null as string | null, since: 0 },
  models: [] as Json[],
  tags: new Map<string, number>(), // model name -> bytes on disk
  gpus: [] as Json[],
  gpuErr: null as string | null,
  win: null as Json | null,
  winErr: null as string | null,
  runners: new Map<number, RunnerTrack>(),
  sorties: [] as Json[],
  history: [] as Json[],
};

const showCache = new Map<string, Json>(); // digest -> slim /api/show

interface Energy { t: number; gpuJ: number; cpuJ: number | null }

interface Sortie {
  t0: number;
  taskId: number | null;
  tFirst: number | null;
  decFirst: number;
  tLast: number;
  ppRate: number | null;
  partial: boolean; // joined a generation already under way
  shifted: boolean; // context shift seen (KV window overflowed)
  e0: Energy;
}

interface RunnerTrack {
  pid: number;
  port: number;
  cmd: string;
  flags: Record<string, string | boolean>;
  modelBlob: string | null;
  props: Json | null;
  meta: Json | null;
  slotOk: boolean;
  nCtx: number | null;
  params: Json | null;
  processing: boolean;
  phase: "idle" | "prefill" | "decode";
  ctxUsed: number;
  promptTokens: number;
  cached: number;
  decoded: number;
  rate: number; // EMA decode tok/s
  peak: number;
  lastDecoded: number;
  lastT: number;
  sortie: Sortie | null;
}

// ---------- helpers ----------

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 2000): Promise<any> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function* readLines(stream: ReadableStream<Uint8Array>) {
  let buf = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "").replace(/^﻿/, "");
      buf = buf.slice(i + 1);
      if (line.trim()) yield line;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const children: Deno.ChildProcess[] = [];

// ---------- energy (power integrated over time) ----------

const energy = {
  gpu: new Map<number, { j: number; p: number; t: number }>(),
  cpuJ: null as number | null, // cumulative RAPL package energy from the sampler
  cpuP: 0,
  cpuT: 0,
};

function addGpuPower(idx: number, watts: number | null, t: number) {
  const e = energy.gpu.get(idx);
  if (!e) {
    energy.gpu.set(idx, { j: 0, p: watts ?? 0, t });
    return;
  }
  if (watts != null) {
    e.j += ((e.p + watts) / 2) * (t - e.t) / 1000; // trapezoid
    e.p = watts;
  }
  e.t = t;
}

function energyNow(): Energy {
  const now = Date.now();
  let gpuJ = 0;
  for (const e of energy.gpu.values()) gpuJ += e.j + e.p * Math.min(2, (now - e.t) / 1000);
  const cpuJ = energy.cpuJ == null ? null : energy.cpuJ + energy.cpuP * Math.min(2, (now - energy.cpuT) / 1000);
  return { t: now, gpuJ, cpuJ };
}

// ---------- Ollama API ----------

function slimShow(s: any): Json {
  const info: Json = {};
  for (const [k, v] of Object.entries(s.model_info ?? {})) {
    if (k.startsWith("tokenizer.ggml.") && Array.isArray(v)) continue; // vocab arrays are huge
    info[k] = v;
  }
  const from = /^FROM\s+(.+)$/m.exec(s.modelfile ?? "");
  return {
    info,
    capabilities: s.capabilities ?? [],
    parameters: s.parameters ?? "",
    details: s.details ?? {},
    modified_at: s.modified_at ?? null,
    license: typeof s.license === "string" ? s.license.split("\n").find((l: string) => l.trim())?.trim() ?? null : null,
    blob: from ? from[1].trim() : null,
    projector: s.projector_info ? true : false,
  };
}

async function pollOllama() {
  while (true) {
    try {
      const ps = await fetchJson(`${OLLAMA}/api/ps`, {}, 1500);
      if (!state.link.ok) {
        const v = await fetchJson(`${OLLAMA}/api/version`).catch(() => ({}));
        state.link = { ok: true, version: v.version ?? null, err: null, since: Date.now() };
        refreshTags();
      }
      const models: Json[] = [];
      for (const m of ps.models ?? []) {
        let show = showCache.get(m.digest);
        if (!show) {
          show = slimShow(await fetchJson(`${OLLAMA}/api/show`, {
            method: "POST",
            body: JSON.stringify({ model: m.name }),
          }, 5000));
          showCache.set(m.digest, show);
          refreshTags();
        }
        models.push({ ...m, show, disk: state.tags.get(m.name) ?? null });
      }
      state.models = models;
    } catch (e) {
      if (state.link.ok || !state.link.err) {
        state.link = { ok: false, version: state.link.version, err: String((e as Error).message ?? e), since: Date.now() };
      }
      state.models = [];
    }
    await sleep(1000);
  }
}

async function refreshTags() {
  try {
    const t = await fetchJson(`${OLLAMA}/api/tags`, {}, 3000);
    for (const m of t.models ?? []) state.tags.set(m.name, m.size);
  } catch { /* tags are optional */ }
}

// ---------- Ollama server.log: load layout + exact per-request timings ----------

interface LoadInfo {
  port: number;
  startedAt: number | null;
  loadSeconds: number | null;
  loadClaimedBy: string | null;
  sysTotal: string | null;
  sysFree: string | null;
  swapFree: string | null;
  gpuAvail: string | null;
  backends: string[];
  device: string | null;
  threads: number | null;
  threadsBatch: number | null;
  threadsMax: number | null;
  layersGpu: number | null;
  layersTotal: number | null;
  model: Record<string, number>; // device -> MiB
  kv: Record<string, number>;
  compute: Record<string, number>;
  kvCaches: { kind: string; mib: number; cells: number; layers: number; typeK: string; typeV: string }[];
  flashAttn: string | null;
  mmprojMiB: number | null;
}

interface TaskInfo {
  id: number;
  port: number;
  promptTokens?: number;
  cached?: number;
  reprocess?: boolean;
  ppMs?: number;
  ppTokens?: number;
  tgMs?: number;
  tgTokens?: number;
  totalMs?: number;
  finalTokens?: number;
  truncated?: boolean;
  cancelled?: boolean;
}

const logState = { offset: 0, rest: "", ok: false, err: null as string | null, current: null as LoadInfo | null, kvKind: "" };
const loads = new Map<number, LoadInfo>();
const tasks = new Map<string, TaskInfo>();

const RX = {
  start: /msg="starting llama-server".*--port (\d+)/,
  time: /^time=(\S+)/,
  sysmem: /msg="system memory" total="([^"]+)" free="([^"]+)" free_swap="([^"]+)"/,
  gpumem: /msg="gpu memory".*available="([^"]+)"/,
  backend: /load_backend: loaded (\S+) backend from (.+)$/,
  device: /Device \d+: (.+?), compute capability ([\d.]+)/,
  threads: /n_threads = (\d+) \(n_threads_batch = (\d+)\) \/ (\d+)/,
  offload: /offloaded (\d+)\/(\d+) layers to GPU/,
  modelBuf: /load_tensors:\s+(\S+) model buffer size =\s+([\d.]+) MiB/,
  kvKind: /creating\s+(non-SWA|SWA) KV cache/,
  kvBuf: /llama_kv_cache:\s+(\S+) KV buffer size =\s+([\d.]+) MiB/,
  kvSize: /llama_kv_cache: size =\s+([\d.]+) MiB \(\s*(\d+) cells,\s+(\d+) layers.*K \((\w+)\).*V \((\w+)\)/,
  compute: /sched_reserve:\s+(\S+) compute buffer size =\s+([\d.]+) MiB/,
  flash: /llama_context: flash_attn\s+=\s+(\w+)/,
  flashOn: /flash attention is enabled/,
  mmproj: /memory usage of mmproj is ([\d.]+) MiB/,
  started: /llama-server started in ([\d.]+) seconds/,
  newPrompt: /task (\d+) \| new prompt, .*task\.n_tokens = (\d+)/,
  cached: /task (\d+) \| cached n_tokens = (\d+)/,
  reprocess: /task (\d+) \| forcing full prompt re-processing/,
  ppTime: /task (\d+) \| prompt eval time =\s+([\d.]+) ms \/\s+(\d+) tokens/,
  tgTime: /task (\d+) \|\s+eval time =\s+([\d.]+) ms \/\s+(\d+) tokens/,
  total: /task (\d+) \|\s+total time =\s+([\d.]+) ms/,
  release: /task (\d+) \| stop processing: n_tokens = (\d+), truncated = (\d)/,
  cancel: /cancel task, id_task = (\d+)/,
};

function taskOf(id: number): TaskInfo {
  const port = logState.current?.port ?? 0;
  const key = `${port}:${id}`;
  let t = tasks.get(key);
  if (!t) {
    t = { id, port };
    tasks.set(key, t);
    if (tasks.size > 500) tasks.delete(tasks.keys().next().value!);
  }
  return t;
}

function parseLogLine(line: string) {
  let m: RegExpExecArray | null;
  if ((m = RX.start.exec(line))) {
    const tm = RX.time.exec(line);
    const L: LoadInfo = {
      port: +m[1], startedAt: tm ? Date.parse(tm[1]) : null, loadSeconds: null, loadClaimedBy: null,
      sysTotal: null, sysFree: null, swapFree: null, gpuAvail: null, backends: [], device: null,
      threads: null, threadsBatch: null, threadsMax: null, layersGpu: null, layersTotal: null,
      model: {}, kv: {}, compute: {}, kvCaches: [], flashAttn: null, mmprojMiB: null,
    };
    loads.set(L.port, L);
    logState.current = L;
    logState.kvKind = "";
    return;
  }
  const L = logState.current;
  if (!L) return;
  const add = (rec: Record<string, number>, dev: string, mib: string) => { rec[dev] = (rec[dev] ?? 0) + Number(mib); };

  if ((m = RX.newPrompt.exec(line))) { taskOf(+m[1]).promptTokens = +m[2]; return; }
  if ((m = RX.cached.exec(line))) { taskOf(+m[1]).cached = +m[2]; return; }
  if ((m = RX.reprocess.exec(line))) { taskOf(+m[1]).reprocess = true; return; }
  if ((m = RX.ppTime.exec(line))) { const t = taskOf(+m[1]); t.ppMs = +m[2]; t.ppTokens = +m[3]; return; }
  if ((m = RX.tgTime.exec(line))) { const t = taskOf(+m[1]); t.tgMs = +m[2]; t.tgTokens = +m[3]; return; }
  if ((m = RX.total.exec(line))) { taskOf(+m[1]).totalMs = +m[2]; return; }
  if ((m = RX.release.exec(line))) { const t = taskOf(+m[1]); t.finalTokens = +m[2]; t.truncated = m[3] === "1"; return; }
  if ((m = RX.cancel.exec(line))) { taskOf(+m[1]).cancelled = true; return; }

  if ((m = RX.sysmem.exec(line)) && L.sysFree === null) { L.sysTotal = m[1]; L.sysFree = m[2]; L.swapFree = m[3]; return; }
  if ((m = RX.gpumem.exec(line)) && L.gpuAvail === null) { L.gpuAvail = m[1]; return; }
  if ((m = RX.backend.exec(line))) {
    const kind = m[1];
    const path = m[2];
    const cuda = /cuda_v(\d+)/i.exec(path);
    const cpu = /ggml-cpu-(\w+)\.dll/i.exec(path);
    const label = cuda ? `CUDA ${cuda[1]}` : cpu ? `CPU ${cpu[1]}` : kind;
    if (!L.backends.includes(label)) L.backends.push(label);
    return;
  }
  if ((m = RX.device.exec(line)) && !L.device) { L.device = `${m[1]} (算力 ${m[2]})`; return; }
  if ((m = RX.threads.exec(line))) { L.threads = +m[1]; L.threadsBatch = +m[2]; L.threadsMax = +m[3]; return; }
  if ((m = RX.offload.exec(line))) { L.layersGpu = +m[1]; L.layersTotal = +m[2]; return; }
  if ((m = RX.modelBuf.exec(line))) { add(L.model, m[1], m[2]); return; }
  if ((m = RX.kvKind.exec(line))) { logState.kvKind = m[1]; return; }
  if ((m = RX.kvBuf.exec(line))) { add(L.kv, m[1], m[2]); return; }
  if ((m = RX.kvSize.exec(line))) {
    L.kvCaches.push({ kind: logState.kvKind || "KV", mib: +m[1], cells: +m[2], layers: +m[3], typeK: m[4], typeV: m[5] });
    return;
  }
  if ((m = RX.compute.exec(line))) { add(L.compute, m[1], m[2]); return; }
  if ((m = RX.flash.exec(line))) { L.flashAttn = L.flashAttn === "enabled" ? L.flashAttn : m[1]; return; }
  if (RX.flashOn.test(line)) { L.flashAttn = "enabled"; return; }
  if ((m = RX.mmproj.exec(line))) { L.mmprojMiB = +m[1]; return; }
  if ((m = RX.started.exec(line)) && L.loadSeconds === null) { L.loadSeconds = +m[1]; return; }
}

async function tailLog() {
  const dec = new TextDecoder();
  while (true) {
    try {
      const st = await Deno.stat(LOG_PATH);
      if (st.size < logState.offset) { logState.offset = 0; logState.rest = ""; } // rotated
      if (st.size > logState.offset) {
        const f = await Deno.open(LOG_PATH, { read: true });
        try {
          await f.seek(logState.offset, Deno.SeekMode.Start);
          const buf = new Uint8Array(Math.min(st.size - logState.offset, 16 * 1024 * 1024));
          let n = 0;
          while (n < buf.length) {
            const r = await f.read(buf.subarray(n));
            if (r === null) break;
            n += r;
          }
          logState.offset += n;
          const lines = (logState.rest + dec.decode(buf.subarray(0, n), { stream: true })).split(/\r?\n/);
          logState.rest = lines.pop() ?? "";
          for (const l of lines) parseLogLine(l);
        } finally {
          f.close();
        }
      }
      logState.ok = true;
      logState.err = null;
    } catch (e) {
      logState.ok = false;
      logState.err = String((e as Error).message ?? e);
    }
    await sleep(500);
  }
}

// ---------- nvidia-smi ----------

const GPU_FIELDS = [
  "index", "name", "utilization.gpu", "utilization.memory", "memory.used", "memory.total",
  "temperature.gpu", "power.draw", "power.limit", "clocks.sm", "clocks.mem", "clocks.max.sm",
  "clocks.max.mem", "fan.speed", "pstate", "pcie.link.gen.current", "pcie.link.width.current",
  "clocks_event_reasons.active",
];
const GPU_KEYS = [
  "index", "name", "util", "memUtil", "memUsed", "memTotal", "temp", "power", "powerLimit",
  "smClock", "memClock", "smClockMax", "memClockMax", "fan", "pstate", "pcieGen", "pcieWidth", "reasons",
];
const GPU_TEXT = new Set(["name", "pstate", "reasons"]);

async function probeGpuFields(): Promise<string[] | null> {
  const variants = [
    GPU_FIELDS,
    GPU_FIELDS.map((f) => f === "clocks_event_reasons.active" ? "clocks_throttle_reasons.active" : f),
    GPU_FIELDS.slice(0, -1),
  ];
  for (const fields of variants) {
    try {
      const out = await new Deno.Command("nvidia-smi", {
        args: [`--query-gpu=${fields.join(",")}`, "--format=csv,noheader,nounits"],
        stdout: "piped", stderr: "piped",
      }).output();
      if (out.success) return fields;
    } catch {
      return null; // nvidia-smi not installed
    }
  }
  return null;
}

async function runNvidiaSmi() {
  const fields = await probeGpuFields();
  if (!fields) {
    state.gpuErr = "nvidia-smi 不可用";
    return;
  }
  while (true) {
    let child: Deno.ChildProcess | null = null;
    try {
      child = new Deno.Command("nvidia-smi", {
        args: [`--query-gpu=${fields.join(",")}`, "--format=csv,noheader,nounits", "-lms", "500"],
        stdout: "piped", stderr: "null",
      }).spawn();
      children.push(child);
      state.gpuErr = null;
      // A long-running -lms stream can go stale and report [N/A] for every live field
      // (seen after Ollama unloads a model); restart it then, and recycle it every 15 min anyway.
      const started = Date.now();
      let stale = 0;
      for await (const line of readLines(child.stdout)) {
        const parts = line.split(",").map((s) => s.trim());
        if (parts.length < fields.length) continue;
        const g: Json = {};
        fields.forEach((_, i) => {
          const key = GPU_KEYS[i];
          const raw = parts[i];
          if (GPU_TEXT.has(key)) g[key] = raw.startsWith("[") ? null : raw;
          else {
            const n = Number(raw);
            g[key] = raw.startsWith("[") || !Number.isFinite(n) ? null : n;
          }
        });
        const idx = (g.index as number) ?? 0;
        const t = Date.now();
        if (g.util == null && g.memUsed == null && g.power == null) {
          if (++stale >= 6) {
            state.gpuErr = "nvidia-smi 返回 N/A，正在重启";
            break;
          }
          continue;
        }
        stale = 0;
        addGpuPower(idx, g.power as number | null, t);
        state.gpus[idx] = { ...g, t };
        if (t - started > 15 * 60 * 1000) break;
      }
    } catch (e) {
      state.gpuErr = String((e as Error).message ?? e);
    }
    if (child) {
      try { child.kill(); } catch { /* already exited */ }
      children.splice(children.indexOf(child), 1);
    }
    await sleep(1000);
  }
}

// ---------- PowerShell sampler ----------

async function runSampler() {
  const script = new URL("./sampler.ps1", HERE);
  while (true) {
    try {
      const child = new Deno.Command("powershell.exe", {
        args: [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", decodeURIComponent(script.pathname.replace(/^\/([A-Za-z]:)/, "$1")),
          "-IntervalMs", "1000", "-ParentPid", String(Deno.pid),
        ],
        stdout: "piped", stderr: "null",
      }).spawn();
      children.push(child);
      for await (const line of readLines(child.stdout)) {
        try {
          const w = JSON.parse(line);
          state.win = w;
          state.winErr = null;
          if (w.cpu?.energyJ != null) {
            energy.cpuJ = w.cpu.energyJ;
            energy.cpuP = w.cpu.power ?? 0;
            energy.cpuT = Date.now();
          }
          syncRunners(w.procs ?? []);
        } catch { /* partial line */ }
      }
      state.winErr = "系统采样进程退出";
    } catch (e) {
      state.winErr = String((e as Error).message ?? e);
    }
    await sleep(3000);
  }
}

function parseFlags(cmd: string): Record<string, string | boolean> {
  const tokens = cmd.match(/"[^"]*"|\S+/g) ?? [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("-")) continue;
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags[t] = next.replace(/^"|"$/g, "");
      i++;
    } else flags[t] = true;
  }
  return flags;
}

function syncRunners(procs: any[]) {
  const seen = new Set<number>();
  for (const p of procs) {
    if (p.role !== "runner" || !p.port) continue;
    seen.add(p.pid);
    if (state.runners.has(p.pid)) continue;
    const flags = parseFlags(p.cmd ?? "");
    const r: RunnerTrack = {
      pid: p.pid, port: p.port, cmd: p.cmd ?? "", flags,
      modelBlob: (flags["--model"] as string) ?? null,
      props: null, meta: null, slotOk: false, nCtx: null, params: null,
      processing: false, phase: "idle", ctxUsed: 0, promptTokens: 0, cached: 0, decoded: 0,
      rate: 0, peak: 0, lastDecoded: 0, lastT: 0, sortie: null,
    };
    state.runners.set(p.pid, r);
    pollRunner(r);
  }
  for (const pid of [...state.runners.keys()]) {
    if (!seen.has(pid)) state.runners.delete(pid);
  }
}

// ---------- runner /slots tracking ----------

async function pollRunner(r: RunnerTrack) {
  const base = `http://127.0.0.1:${r.port}`;
  try {
    const props = await fetchJson(`${base}/props`, {}, 3000);
    r.props = {
      n_ctx: props.default_generation_settings?.n_ctx ?? null,
      total_slots: props.total_slots ?? null,
      model_ftype: props.model_ftype ?? null,
      modalities: props.modalities ?? null,
      chat_format: props.default_generation_settings?.params?.chat_format ?? null,
    };
  } catch { /* older runners have no /props */ }
  try {
    const models = await fetchJson(`${base}/v1/models`, {}, 3000);
    r.meta = models.data?.[0]?.meta ?? null;
  } catch { /* optional */ }

  while (state.runners.get(r.pid) === r) {
    try {
      const slots = await fetchJson(`${base}/slots`, {}, 1500);
      r.slotOk = true;
      updateSlot(r, Array.isArray(slots) ? slots : []);
    } catch {
      r.slotOk = false;
    }
    await sleep(SLOT_POLL_MS);
  }
}

function startSortie(r: RunnerTrack, now: number, taskId: number | null, decoded: number) {
  r.sortie = {
    t0: now, taskId, tFirst: null, decFirst: 0, tLast: now, ppRate: null,
    partial: decoded > 0, shifted: false, e0: energyNow(),
  };
  r.lastDecoded = decoded;
  r.lastT = now;
  r.rate = 0;
}

function endSortie(r: RunnerTrack, now: number) {
  const so = r.sortie!;
  const e1 = energyNow();
  const tgSpan = so.tFirst !== null ? (so.tLast - so.tFirst) / 1000 : 0;
  const cpuJ = so.e0.cpuJ != null && e1.cpuJ != null ? e1.cpuJ - so.e0.cpuJ : null;
  const gpuJ = e1.gpuJ - so.e0.gpuJ;
  const rec: Json = {
    id: `${r.pid}-${so.t0}`,
    src: "runner",
    port: r.port,
    taskId: so.taskId,
    start: so.t0,
    end: now,
    promptTokens: r.promptTokens,
    cached: r.cached,
    decoded: r.lastDecoded,
    ttft: so.tFirst !== null && !so.partial ? (so.tFirst - so.t0) / 1000 : null,
    ppRate: so.partial ? null : so.ppRate,
    tgRate: tgSpan > 0.3 ? (r.lastDecoded - so.decFirst) / tgSpan : null,
    total: (now - so.t0) / 1000,
    partial: so.partial,
    shifted: so.shifted,
    truncated: so.shifted,
    ctxUsed: r.ctxUsed,
    nCtx: r.nCtx,
    cpuJ,
    gpuJ,
    energyJ: gpuJ + (cpuJ ?? 0),
    exact: false,
  };
  enrichSortie(rec);
  state.sorties.unshift(rec);
  state.sorties.length = Math.min(state.sorties.length, 40);
  r.sortie = null;
  r.phase = "idle";
  r.rate = 0;
}

function updateSlot(r: RunnerTrack, slots: any[]) {
  const now = Date.now();
  const active = slots.filter((s) => s.is_processing);
  const s = active[0] ?? slots[0];
  if (!s) return;
  r.nCtx = s.n_ctx ?? r.nCtx;
  r.params = s.params ? {
    temperature: s.params.temperature, top_k: s.params.top_k, top_p: s.params.top_p,
    min_p: s.params.min_p, repeat_penalty: s.params.repeat_penalty, n_predict: s.params.n_predict,
    n_keep: s.params.n_keep, reasoning_format: s.params.reasoning_format, seed: s.params.seed,
  } : r.params;

  const processing = active.length > 0;
  const decoded = active.reduce((a, x) => a + (x.next_token?.[0]?.n_decoded ?? 0), 0);
  const taskId = processing ? (s.id_task ?? null) : null;
  const prevCtx = r.ctxUsed;
  r.ctxUsed = s.n_prompt_tokens ?? r.ctxUsed; // idle: what the KV cache still holds

  if (r.sortie && (!processing || (taskId !== null && taskId !== r.sortie.taskId))) endSortie(r, now);
  if (processing && !r.sortie) startSortie(r, now, taskId, decoded);

  if (processing && r.sortie) {
    r.promptTokens = s.n_prompt_tokens_processed ?? r.promptTokens;
    r.cached = s.n_prompt_tokens_cache ?? 0;
    if (decoded > 0 && r.sortie.tFirst === null) {
      r.sortie.tFirst = now;
      r.sortie.decFirst = decoded;
      const pp = Math.max(0, r.promptTokens - r.cached);
      const dt = (now - r.sortie.t0) / 1000;
      r.sortie.ppRate = !r.sortie.partial && dt > 0.05 && pp > 0 ? pp / dt : null;
    }
    const dt = (now - r.lastT) / 1000;
    if (decoded > r.lastDecoded && dt > 0) {
      const inst = (decoded - r.lastDecoded) / dt;
      r.rate = r.rate ? r.rate + (inst - r.rate) * Math.min(1, dt / 1.2) : inst;
      r.lastDecoded = decoded;
      r.lastT = now;
      r.sortie.tLast = now;
    } else if (dt > 2.5) {
      r.rate *= 0.85; // stalled (prefill of a new turn, tool call...)
    }
    if (decoded > 0 && r.ctxUsed < prevCtx) r.sortie.shifted = true; // context shift dropped old tokens
    r.decoded = decoded;
    r.phase = decoded > 0 ? "decode" : "prefill";
    r.peak = Math.max(r.peak, r.rate);
  }
  r.processing = processing;
}

// Replace slot-sampled estimates with llama-server's own timings once they reach the log.
function enrichSortie(so: any) {
  if (so.final) return;
  const t = tasks.get(`${so.port}:${so.taskId}`);
  const L = loads.get(so.port);
  if (L?.startedAt && L.loadSeconds != null && (!L.loadClaimedBy || L.loadClaimedBy === so.id)) {
    const loadDone = L.startedAt + L.loadSeconds * 1000;
    if (so.start >= L.startedAt && so.start - loadDone < 5000) {
      so.load = L.loadSeconds;
      L.loadClaimedBy = so.id;
    }
  }
  if (!t) return;
  if (t.promptTokens != null) so.promptTokens = t.promptTokens;
  if (t.cached != null) so.cached = t.cached;
  if (t.reprocess) so.reprocess = true;
  if (t.ppMs != null && t.ppTokens) {
    so.processed = t.ppTokens;
    so.prefillMs = t.ppMs;
    so.ppRate = t.ppTokens / (t.ppMs / 1000);
  }
  if (t.tgMs != null && t.tgTokens) {
    so.decoded = t.tgTokens;
    so.decodeMs = t.tgMs;
    so.tgRate = t.tgTokens / (t.tgMs / 1000);
    so.tpotMs = t.tgMs / t.tgTokens;
  }
  if (t.ppMs != null && t.tgMs != null && t.tgTokens) so.ttft = (t.ppMs + t.tgMs / t.tgTokens) / 1000;
  if (t.totalMs != null) so.runnerMs = t.totalMs;
  if (t.truncated) so.truncated = true;
  if (t.cancelled) so.cancelled = true;
  so.exact = t.ppMs != null || t.tgMs != null;
  so.final = t.finalTokens != null || !!t.cancelled;
}
setInterval(() => { for (const so of state.sorties) enrichSortie(so); }, 1000);

// ---------- snapshot + history ----------

function runnerView(r: RunnerTrack): Json {
  const task = r.sortie?.taskId != null ? tasks.get(`${r.port}:${r.sortie.taskId}`) : null;
  return {
    pid: r.pid, port: r.port, cmd: r.cmd, flags: r.flags, modelBlob: r.modelBlob,
    props: r.props, meta: r.meta, slotOk: r.slotOk, nCtx: r.nCtx, params: r.params,
    processing: r.processing, phase: r.phase, ctxUsed: r.ctxUsed, promptTokens: r.promptTokens,
    cached: r.cached, decoded: r.decoded, rate: r.rate, peak: r.peak,
    sortie: r.sortie ? { t0: r.sortie.t0, tFirst: r.sortie.tFirst, ppRate: r.sortie.ppRate, taskId: r.sortie.taskId, shifted: r.sortie.shifted } : null,
    task: task ?? null,
    load: loads.get(r.port) ?? null,
  };
}

function snapshot(): Json {
  const runners = [...state.runners.values()];
  const active = runners.find((r) => r.processing) ?? runners[0] ?? null;
  return {
    t: Date.now(),
    ollama: OLLAMA,
    link: state.link,
    models: state.models,
    gpus: state.gpus.filter(Boolean),
    gpuErr: state.gpuErr,
    win: state.win,
    winErr: state.winErr,
    runners: runners.map(runnerView),
    activePid: active?.pid ?? null,
    sorties: state.sorties.slice(0, 30),
    energy: energyNow(),
    log: { ok: logState.ok, err: logState.err, path: LOG_PATH },
    hist: state.history[state.history.length - 1] ?? null,
  };
}

function sampleHistory() {
  const runners = [...state.runners.values()];
  const active = runners.find((r) => r.processing);
  const gpus = state.gpus.filter(Boolean) as any[];
  const g = gpus[0];
  const w = state.win as any;
  const runnerProc = w?.procs?.find((p: any) => p.pid === (active ?? runners[0])?.pid);
  const memUsed = w?.mem ? (w.mem.total - w.mem.avail) / w.mem.total * 100 : null;
  const gpuPwr = gpus.length ? gpus.reduce((a, x) => a + (x.power ?? 0), 0) : null;
  const cpuPwr = w?.cpu?.power ?? null;
  state.history.push({
    t: Date.now(),
    tps: active ? +active.rate.toFixed(2) : 0,
    gpu: g?.util ?? null,
    memUtil: g?.memUtil ?? null,
    cpu: w?.cpu?.total ?? null,
    rcpu: runnerProc?.cpu ?? null,
    vram: g?.memUsed ?? null,
    pwr: gpuPwr,
    cpuPwr: cpuPwr != null ? +cpuPwr.toFixed(1) : null,
    totPwr: gpuPwr != null || cpuPwr != null ? +((gpuPwr ?? 0) + (cpuPwr ?? 0)).toFixed(1) : null,
    temp: g?.temp ?? null,
    ram: memUsed !== null ? +memUsed.toFixed(1) : null,
    hard: w?.mem?.hardFaults != null ? Math.round(w.mem.hardFaults) : null,
  });
  if (state.history.length > HISTORY_LEN) state.history.splice(0, state.history.length - HISTORY_LEN);
}

// ---------- LAN access ----------

const KEY_FILE = new URL("./.cockpit-key", HERE);

function loadOrCreateKey(): string {
  try {
    const k = Deno.readTextFileSync(KEY_FILE).trim();
    if (/^[a-z0-9]{10,}$/.test(k)) return k;
  } catch { /* first run */ }
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const k = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  Deno.writeTextFileSync(KEY_FILE, k + "\n");
  return k;
}
const KEY = LAN ? loadOrCreateKey() : "";

function lanAddresses(): string[] {
  // Real Wi-Fi/Ethernet first; skip loopback, link-local and virtual/VPN adapters.
  const virtual = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|QuickFox|TAP|TUN|WireGuard|ZeroTier|Tailscale|VPN/i;
  const rank = (name: string) => /WLAN|Wi-?Fi|无线/i.test(name) ? 0 : /Ethernet|以太网/i.test(name) ? 1 : 2;
  try {
    return Deno.networkInterfaces()
      .filter((n) => n.family === "IPv4" && !n.address.startsWith("127.") && !n.address.startsWith("169.254.") && !virtual.test(n.name))
      .sort((a, b) => rank(a.name) - rank(b.name))
      .map((n) => n.address)
      .filter((a, i, all) => all.indexOf(a) === i);
  } catch {
    return [];
  }
}

const isLoopback = (host: string) => host === "127.0.0.1" || host === "::1" || host.startsWith("::ffff:127.");

function cookieKey(req: Request): string | null {
  const m = /(?:^|;\s*)cockpit_key=([^;]+)/.exec(req.headers.get("cookie") ?? "");
  return m ? m[1] : null;
}

const DENIED_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Ollama 座舱</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#020705;color:#c9f7df;
font:15px/1.6 "Microsoft YaHei UI",sans-serif;padding:16px}div{max-width:420px;border:1px solid rgba(93,255,168,.34);
border-radius:8px;padding:20px}b{color:#5dffa8}</style></head><body><div><b>需要访问码</b><br>
这块仪表盘只给你自己的设备看。请在电脑上打开仪表盘，点右上角的「手机」，用手机扫二维码进入（扫一次以后会记住）。</div></body></html>`;

// ---------- HTTP ----------

const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();

setInterval(() => {
  if (!sseClients.size) return;
  const msg = enc.encode(`data: ${JSON.stringify(snapshot())}\n\n`);
  for (const c of sseClients) {
    try { c.enqueue(msg); } catch { sseClients.delete(c); }
  }
}, PUSH_MS);
setInterval(sampleHistory, 1000);

async function handle(req: Request, info: Deno.ServeHandlerInfo): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const local = isLoopback((info.remoteAddr as Deno.NetAddr).hostname);

  if (!local) {
    if (url.searchParams.get("key") === KEY) {
      // Trade the key in the QR link for a long-lived cookie, then drop it from the address bar.
      return new Response(null, {
        status: 302,
        headers: { location: "/", "set-cookie": `cockpit_key=${KEY}; Path=/; Max-Age=31536000; SameSite=Strict; HttpOnly` },
      });
    }
    if (cookieKey(req) !== KEY) {
      return new Response(DENIED_PAGE, { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
    }
  }

  if (p === "/api/lan") {
    if (!local) return Response.json({ lan: LAN, remote: true });
    return Response.json({ lan: LAN, port: listenPort, urls: LAN ? lanAddresses().map((a) => `http://${a}:${listenPort}/?key=${KEY}`) : [] });
  }

  if (p === "/" || p === "/index.html") {
    const html = await Deno.readFile(new URL("./index.html", HERE));
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  if (p === "/api/stream") {
    let ctl: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
        sseClients.add(c);
        c.enqueue(enc.encode(`retry: 2000\ndata: ${JSON.stringify(snapshot())}\n\n`));
      },
      cancel() { sseClients.delete(ctl); },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive" },
    });
  }

  if (p === "/api/history") {
    return Response.json(state.history);
  }

  // Pass-through to Ollama for the test-flight panel (keeps the page same-origin).
  // When the browser aborts, the response stream is cancelled and so is the upstream request,
  // which makes Ollama stop generating.
  if (p.startsWith("/ollama/")) {
    const target = OLLAMA + p.slice("/ollama".length) + url.search;
    const upstream = new AbortController();
    try {
      const r = await fetch(target, {
        method: req.method,
        headers: { "content-type": "application/json" },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
        signal: upstream.signal,
      });
      const reader = r.body?.getReader();
      const body = reader && new ReadableStream<Uint8Array>({
        async pull(c) {
          try {
            const { value, done } = await reader.read();
            if (done) c.close();
            else c.enqueue(value);
          } catch (e) {
            c.error(e);
          }
        },
        cancel() { upstream.abort(); },
      });
      return new Response(body ?? null, {
        status: r.status,
        headers: { "content-type": r.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
      });
    } catch (e) {
      return Response.json({ error: String((e as Error).message ?? e) }, { status: 502 });
    }
  }

  return new Response("not found", { status: 404 });
}

function shutdown() {
  for (const c of children) {
    try { c.kill(); } catch { /* already gone */ }
  }
  Deno.exit(0);
}
for (const sig of ["SIGINT", "SIGBREAK"] as const) {
  try { Deno.addSignalListener(sig, shutdown); } catch { /* not supported */ }
}

let listenPort = BASE_PORT;
function serve(): { port: number } {
  for (let port = BASE_PORT; port < BASE_PORT + 20; port++) {
    try {
      Deno.serve({ hostname: LAN ? "0.0.0.0" : "127.0.0.1", port, onListen: () => {} }, handle);
      return { port };
    } catch (e) {
      if (!(e instanceof Deno.errors.AddrInUse)) throw e;
    }
  }
  throw new Error("no free port");
}

const { port } = serve();
listenPort = port;
const pageUrl = `http://127.0.0.1:${port}/`;
console.log(`Ollama 座舱  本机: ${pageUrl}   (Ollama: ${OLLAMA})   按 Ctrl+C 停止`);
if (LAN) {
  const urls = lanAddresses();
  console.log(urls.length
    ? `手机（同一 Wi-Fi）: http://${urls[0]}:${port}/   第一次请在电脑仪表盘上点「手机」扫码`
    : "已开启局域网访问，但没找到 Wi-Fi/有线网卡地址");
}
if (Deno.args.includes("--open")) {
  new Deno.Command("cmd", { args: ["/c", "start", "", pageUrl], stdout: "null", stderr: "null" }).spawn();
}

tailLog();
pollOllama();
runNvidiaSmi();
runSampler();
