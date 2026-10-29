import type { GpuSample, NodeGpuObservation } from "../fleet/pc-observations.ts";
import type { DatabaseSync } from "node:sqlite";

export interface GpuRecorderBinding { address: string; nodeContainerId: string; gpuUuids: string[] }
/** A small strict XML reader for the fixed nvidia-smi output, never an XML entity
 * resolver. Unsupported flags/counters remain unknown rather than measured zero. */
export function parseNvidiaSamples(xml: string, gpuUuids: readonly string[], at: number): GpuSample[] {
  if (Buffer.byteLength(xml) > 2 * 1024 * 1024 || !Number.isSafeInteger(at) || at <= 0) throw new Error("Invalid NVIDIA observation.");
  const text = xml.replace(/<!DOCTYPE nvidia_smi_log SYSTEM "nvsmi_device_v[0-9]+\.dtd">/g, "");
  if (/<!DOCTYPE|<!ENTITY|&(?:#|[A-Za-z])/i.test(text) || !/<nvidia_smi_log>/.test(text) || !/<\/nvidia_smi_log>/.test(text)) throw new Error("Unsupported NVIDIA XML.");
  const blocks = [...text.matchAll(/<gpu\b[^>]*>([\s\S]*?)<\/gpu>/g)];
  if (blocks.length !== gpuUuids.length || blocks.length > 64) throw new Error("GPU allocation changed.");
  const one = (body: string, tag: string): string | null => {
    const values = [...body.matchAll(new RegExp(`<${tag}>([^<>]*)<\\/${tag}>`, "g"))];
    if (values.length > 1) throw new Error("Duplicate NVIDIA field.");
    return values[0]?.[1]?.trim() ?? null;
  };
  const section = (body: string, tag: string): string => {
    const values = [...body.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g"))];
    if (values.length > 1) throw new Error("Duplicate NVIDIA section.");
    return values[0]?.[1] ?? "";
  };
  const fields = [["sw_thermal_slowdown", "sw_therm_slowdown"], ["hw_thermal_slowdown", "hw_therm_slowdown"],
    ["sw_power_cap", "sw_power_cap"], ["hw_power_brake_slowdown", "hw_power_brake"]] as const;
  const seen = new Set<string>();
  return blocks.map(block => {
    const body = block[1]!, raw = one(body, "uuid"), uuid = raw?.toLowerCase().replace(/^gpu-/, "GPU-");
    if (!uuid || !/^GPU-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uuid) || seen.has(uuid) || !gpuUuids.includes(uuid)) throw new Error("GPU identity changed.");
    seen.add(uuid);
    let supported = 0, active = 0;
    const counters = fields.map(([flag, counter], index): number | null => {
      const modern = one(section(body, "clocks_event_reasons"), `clocks_event_reason_${flag}`);
      const legacy = one(section(body, "clocks_throttle_reasons"), `clocks_throttle_reason_${flag}`);
      if (modern !== null && legacy !== null && modern !== legacy) throw new Error("Conflicting NVIDIA flags.");
      const value = modern ?? legacy;
      if (value === "Active" || value === "Not Active") supported |= 1 << index;
      if (value === "Active") active |= 1 << index;
      const rawCounter = one(section(body, "clocks_event_reasons_counters"), `clocks_event_reasons_counters_${counter}`);
      if (rawCounter === null || !/^(?:0|[1-9][0-9]{0,15})(?: us)?$/.test(rawCounter)) return null;
      const duration = Number(rawCounter.replace(/ us$/, "")); return Number.isSafeInteger(duration) ? duration : null;
    });
    return [at, gpuUuids.indexOf(uuid), supported, active, ...counters] as GpuSample;
  }).sort((a, b) => a[1] - b[1]);
}

export function initializeGpuDatabase(db: DatabaseSync, binding: GpuRecorderBinding): void {
  db.exec("PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=4096;");
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (version !== 0 && version !== 1) throw new Error("Unsupported GPU database.");
  db.exec("CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS samples (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, gpu INTEGER NOT NULL, value TEXT NOT NULL); CREATE INDEX IF NOT EXISTS samples_at ON samples(at); CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), status TEXT NOT NULL, attempted INTEGER NOT NULL, succeeded INTEGER); PRAGMA user_version=1;");
  const value = JSON.stringify(binding), prior = db.prepare("SELECT value FROM binding WHERE id=1").get()?.value;
  if (prior !== undefined && prior !== value) throw new Error("GPU database binding changed.");
  db.prepare("INSERT OR IGNORE INTO binding VALUES(1,?)").run(value);
}
export function recordGpuSamples(db: DatabaseSync, binding: GpuRecorderBinding, samples: GpuSample[], at: number, status: string): void {
  const previous = db.prepare("SELECT succeeded FROM metadata WHERE id=1").get()?.succeeded;
  if (typeof previous === "number" && at <= previous) { status = "clock-regressed"; samples = []; }
  if (!["ok", "unsupported", "query-failed", "invalid-response", "identity-mismatch", "clock-regressed", "clock-untrusted"].includes(status)
    || !Number.isSafeInteger(at) || at <= 0 || samples.length > binding.gpuUuids.length) throw new Error("Invalid GPU recording.");
  if (status === "clock-regressed" || status === "clock-untrusted") samples = [];
  const succeeded = status === "ok" || status === "unsupported" ? at : typeof previous === "number" ? previous : null;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (status !== "clock-regressed" && status !== "clock-untrusted") db.prepare("DELETE FROM samples WHERE at < ?").run(Math.max(0, at - 7 * 86_400_000));
    const count = Number(db.prepare("SELECT count(*) AS n FROM samples").get()?.n);
    const overflow = Math.max(0, count + samples.length - 20_000);
    if (overflow) db.prepare("DELETE FROM samples WHERE id IN (SELECT id FROM samples ORDER BY id LIMIT ?)").run(overflow);
    const insert = db.prepare("INSERT INTO samples(at,gpu,value) VALUES(?,?,?)");
    for (const sample of samples) {
      if (sample[0] !== at || !Number.isInteger(sample[1]) || sample[1] < 0 || sample[1] >= binding.gpuUuids.length
        || sample.length !== 8 || !Number.isInteger(sample[2]) || sample[2] < 0 || sample[2] > 15 || !Number.isInteger(sample[3])
        || sample[3] < 0 || (sample[3] & ~sample[2]) !== 0 || sample.slice(4).some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))) throw new Error("Invalid GPU sample.");
      insert.run(at, sample[1], JSON.stringify(sample));
    }
    db.prepare("INSERT OR REPLACE INTO metadata VALUES(1,?,?,?)").run(status, at, succeeded); db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function readGpuDatabase(db: DatabaseSync, binding: GpuRecorderBinding, now: number, from = Math.max(0, now - 86_400_000)): NodeGpuObservation {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(from) || from < 0 || from > now || now - from > 7 * 86_400_000) throw new Error("Invalid GPU history window.");
  if (db.prepare("SELECT value FROM binding WHERE id=1").get()?.value !== JSON.stringify(binding)) throw new Error("GPU database binding changed.");
  const metadata = db.prepare("SELECT status,attempted,succeeded FROM metadata WHERE id=1").get();
  let status = typeof metadata?.status === "string" ? metadata.status : "starting";
  const attempted = typeof metadata?.attempted === "number" ? metadata.attempted : null;
  if (attempted !== null && attempted > now + 5000) status = "clock-untrusted";
  else if (attempted !== null && now - attempted > 45_000) status = "stale";
  const rows = db.prepare("SELECT value FROM samples WHERE at >= ? AND at <= ? ORDER BY at DESC,gpu DESC LIMIT 6001").all(from, now);
  const truncated = rows.length > 6000, selected = rows.slice(0, 6000).reverse();
  return { schema: 2, address: binding.address, observedAtMs: typeof metadata?.succeeded === "number" ? metadata.succeeded : null,
    status, gpuUuids: [...binding.gpuUuids], intervalSeconds: 15, fromAtMs: from, toAtMs: now, truncated,
    clockTrusted: attempted !== null && !["clock-untrusted", "clock-regressed"].includes(status), samples: selected.map(row => JSON.parse(String(row.value)) as GpuSample) };
}

/** Container entry point. The serialized form contains only built-ins and the
 * fixed helpers above; operators never need Node installed on their host. */
export async function gpuRecorderMain(binding: GpuRecorderBinding, args: string[]): Promise<void> {
  const fs = require("node:fs") as typeof import("node:fs");
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  const http = require("node:http") as typeof import("node:http");
  const os = require("node:os") as typeof import("node:os");
  const path = "/data/gpu.sqlite";
  try { if (!fs.lstatSync(path).isFile()) throw new Error("Invalid GPU database path."); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  if (args[0] === "read") {
    if (args.length > 2 || args[1] !== undefined && !/^\d{1,16}$/.test(args[1])) throw new Error("Invalid GPU read.");
    const db = new DatabaseSync(path, { readOnly: true });
    try { process.stdout.write(JSON.stringify(readGpuDatabase(db, binding, Date.now(), args[1] === undefined ? undefined : Number(args[1]))) + "\n"); }
    finally { db.close(); }
    return;
  }
  if (args.length !== 1 || args[0] !== "run") throw new Error("Invalid GPU recorder operation.");
  const db = new DatabaseSync(path); initializeGpuDatabase(db, binding); fs.chmodSync(path, 0o600);
  let stopping = false, timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined;
  process.once("SIGTERM", () => { stopping = true; if (timer) clearTimeout(timer); wake?.(); });
  process.once("SIGINT", () => { stopping = true; if (timer) clearTimeout(timer); wake?.(); });
  let wall: number | undefined, monotonic: number | undefined;
  const verify = (): Promise<boolean> => new Promise(resolve => {
    let body = "", done = false;
    const finish = (matched: boolean): void => { if (done) return; done = true; clearTimeout(timeout); request.destroy(); resolve(matched); };
    const request = http.get({ host: "127.0.0.1", port: 5001, path: "/", agent: false }, response => {
      response.on("data", chunk => { body += chunk; if (Buffer.byteLength(body) > 256) finish(false); });
      response.on("error", () => finish(false)); response.on("aborted", () => finish(false));
      response.on("end", () => { try { finish(response.statusCode === 200 && JSON.parse(body) === binding.address); } catch { finish(false); } });
    });
    const timeout = setTimeout(() => finish(false), 3000); request.on("error", () => finish(false));
  });
  try {
    while (!stopping) {
      let status = "ok", samples: GpuSample[] = [];
      const at = Date.now(), mono = os.uptime() * 1000;
      const trusted = wall === undefined || monotonic === undefined || mono >= monotonic && Math.abs((at - wall) - (mono - monotonic)) <= 5000;
      if (!trusted) status = "clock-untrusted";
      else {
        wall = at; monotonic = mono;
        try {
          if (!await verify()) status = "identity-mismatch";
          else {
            const executable = fs.existsSync("/usr/bin/nvidia-smi") ? "/usr/bin/nvidia-smi" : "/usr/local/nvidia/bin/nvidia-smi";
            const xml = execFileSync(executable, ["-q", "-x"], { encoding: "utf8", timeout: 8000, maxBuffer: 2 * 1024 * 1024,
              stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/usr/local/nvidia/bin", LD_LIBRARY_PATH: "/usr/local/nvidia/lib:/usr/local/nvidia/lib64" } });
            samples = parseNvidiaSamples(xml, binding.gpuUuids, Date.now());
            if (samples.every(sample => sample[2] === 0 && sample.slice(4).every(value => value === null))) status = "unsupported";
          }
        } catch { status = "query-failed"; }
      }
      const after = Date.now(), afterMono = os.uptime() * 1000;
      if (after < at || afterMono < mono || Math.abs((after - at) - (afterMono - mono)) > 5000) { status = "clock-untrusted"; samples = []; }
      const observedAt = samples[0]?.[0] ?? at;
      recordGpuSamples(db, binding, samples, observedAt, status);
      if (stopping) break;
      await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 15_000); });
    }
  } finally { db.close(); }
}

export function gpuRecorderSource(binding: GpuRecorderBinding): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(binding.address) || !/^[a-f0-9]{64}$/.test(binding.nodeContainerId)
    || !binding.gpuUuids.length || binding.gpuUuids.length > 64 || new Set(binding.gpuUuids).size !== binding.gpuUuids.length
    || binding.gpuUuids.some(value => !/^GPU-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))) throw new Error("Invalid GPU recorder binding.");
  return "'use strict';\nconst GRIDLENS_GPU_BINDING=" + JSON.stringify(binding) + ";\n"
    + [parseNvidiaSamples, initializeGpuDatabase, recordGpuSamples, readGpuDatabase, gpuRecorderMain].map(value => value.toString()).join("\n")
    + '\ngpuRecorderMain(GRIDLENS_GPU_BINDING,process.argv.slice(1)).catch(()=>{process.stderr.write("GPU recorder unavailable.\\n");process.exitCode=1;});';
}
