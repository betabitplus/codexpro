import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { codexProHome } from "./profileStore.js";

const JOURNAL_FILENAME = "tool-activity.jsonl";
const DEFAULT_MAX_JOURNAL_BYTES = 50 * 1024 * 1024;
const MAX_JOURNAL_BACKUPS = 4;
const SERVER_INSTANCE_ID = randomUUID();
const PROCESS_STARTED_AT_MS = Date.now();

type JsonObject = Record<string, unknown>;

export interface CorrelationExtra {
  requestId?: unknown;
  sessionId?: unknown;
  _meta?: unknown;
  requestInfo?: {
    headers?: Record<string, unknown>;
    url?: unknown;
  };
}

export interface ToolActivityHandle {
  id: string;
  startedAt: number;
  tool: string;
  workspaceId: string | null;
  heartbeat?: NodeJS.Timeout;
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
  if (typeof value !== "object") return String(value);
  const objectValue = value as object;
  if (seen.has(objectValue)) return "[circular]";
  seen.add(objectValue);
  const out: JsonObject = {};
  for (const key of Object.keys(value as JsonObject).sort()) {
    out[key] = canonicalize((value as JsonObject)[key], seen);
  }
  seen.delete(objectValue);
  return out;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Fingerprint(value: unknown): string {
  return "sha256:" + createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase();
}

function isSensitiveName(value: string): boolean {
  const name = normalizedName(value);
  return /(authorization|cookie|secret|credential|password|api[-_]?key|token|bearer)/i.test(name);
}

function isCorrelationName(value: string): boolean {
  const name = normalizedName(value);
  if (isSensitiveName(name)) return false;
  return /(openai|oai|chatgpt|conversation|turn|invocation|request|trace|correlation|session)/i.test(name);
}

function argumentShape(value: unknown, depth = 0): unknown {
  if (depth > 6) return "depth-limit";
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      items: value.slice(0, 16).map((item) => argumentShape(item, depth + 1))
    };
  }
  if (typeof value === "object") {
    const out: JsonObject = {};
    for (const key of Object.keys(value as JsonObject).sort()) {
      out[key] = argumentShape((value as JsonObject)[key], depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return { type: "string", length: value.length };
  return typeof value;
}

function instanceEvidence(): JsonObject {
  return {
    server_instance_id: SERVER_INSTANCE_ID,
    server_pid: process.pid,
    process_started_at_ms: PROCESS_STARTED_AT_MS
  };
}

function scalarValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

function collectMetaPaths(
  value: unknown,
  prefix = "",
  paths: string[] = [],
  fingerprints: Record<string, string> = {},
  depth = 0
): { paths: string[]; fingerprints: Record<string, string> } {
  if (depth > 6 || value === null || value === undefined) return { paths, fingerprints };
  if (Array.isArray(value)) {
    value.slice(0, 32).forEach((item, index) =>
      collectMetaPaths(item, prefix + "[" + index + "]", paths, fingerprints, depth + 1)
    );
    return { paths, fingerprints };
  }
  if (typeof value !== "object") return { paths, fingerprints };

  for (const [key, item] of Object.entries(value as JsonObject)) {
    const nextPath = prefix ? prefix + "." + key : key;
    const scalar = scalarValue(item);
    if (scalar !== undefined) {
      paths.push(nextPath);
      if (isCorrelationName(nextPath)) fingerprints[nextPath] = sha256Fingerprint(scalar);
      continue;
    }
    if (item && typeof item === "object") {
      collectMetaPaths(item, nextPath, paths, fingerprints, depth + 1);
    }
  }
  return { paths, fingerprints };
}

export function correlationEvidence(extra: CorrelationExtra | undefined): JsonObject {
  const headers = extra?.requestInfo?.headers ?? {};
  const headerNames = Object.keys(headers).map(normalizedName).filter(Boolean).sort();
  const headerFingerprints: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = normalizedName(rawName);
    const scalar = scalarValue(rawValue);
    if (!name || scalar === undefined || !isCorrelationName(name)) continue;
    headerFingerprints[name] = sha256Fingerprint(scalar);
  }

  const meta = collectMetaPaths(extra?._meta);
  return {
    request_id_sha256: extra?.requestId === undefined ? null : sha256Fingerprint(extra.requestId),
    transport_session_sha256: extra?.sessionId === undefined ? null : sha256Fingerprint(extra.sessionId),
    header_names: headerNames,
    header_fingerprints: headerFingerprints,
    meta_paths: [...new Set(meta.paths)].sort(),
    meta_fingerprints: meta.fingerprints
  };
}

export function activityJournalPath(): string {
  const override = process.env.CODEXPRO_CORRELATION_JOURNAL_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(codexProHome(), "logs", JOURNAL_FILENAME);
}

function journalGloballyEnabled(): boolean {
  return process.env.CODEXPRO_CORRELATION_JOURNAL?.trim().toLowerCase() !== "off";
}

function journalEnabled(extra?: CorrelationExtra): boolean {
  return journalGloballyEnabled() && Boolean(extra?.requestInfo);
}

function journalMaxBytes(): number {
  const raw = process.env.CODEXPRO_CORRELATION_MAX_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_JOURNAL_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_JOURNAL_BYTES;
  return Math.min(1024 * 1024 * 1024, Math.max(1024 * 1024, Math.round(parsed)));
}

function rotateJournalIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < journalMaxBytes()) return;
    try {
      fs.rmSync(filePath + "." + MAX_JOURNAL_BACKUPS, { force: true });
    } catch {
      // best-effort rotation only
    }
    for (let index = MAX_JOURNAL_BACKUPS - 1; index >= 1; index -= 1) {
      const from = filePath + "." + index;
      const to = filePath + "." + (index + 1);
      try {
        fs.renameSync(from, to);
      } catch {
        // rotated generation may not exist yet
      }
    }
    fs.renameSync(filePath, filePath + ".1");
  } catch {
    // file absent or unavailable; append path will handle the rest
  }
}

function appendRecord(record: JsonObject): void {
  try {
    const filePath = activityJournalPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    rotateJournalIfNeeded(filePath);
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Observability must never break a tool call.
  }
}

export function recordServerStart(details: JsonObject = {}): void {
  if (!journalGloballyEnabled()) return;
  appendRecord({
    schema: 1,
    event: "server_start",
    observed_at_ms: Date.now(),
    ...instanceEvidence(),
    ...details
  });
}

function workspaceIdFromArgs(args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const value = (args as JsonObject).workspace_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function heartbeatIntervalMs(): number {
  const raw = process.env.CODEXPRO_CORRELATION_HEARTBEAT_MS?.trim().toLowerCase();
  if (!raw) return 15_000;
  if (raw === "off") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(60_000, Math.max(25, Math.round(parsed)));
}

export function beginToolActivity(tool: string, args: unknown, extra?: CorrelationExtra): ToolActivityHandle | null {
  if (!journalEnabled(extra)) return null;
  const startedAt = Date.now();
  const handle: ToolActivityHandle = {
    id: randomUUID(),
    startedAt,
    tool,
    workspaceId: workspaceIdFromArgs(args)
  };
  const normalizedArgs = args ?? {};
  const canonicalArgs = stableJson(normalizedArgs);
  appendRecord({
    schema: 1,
    event: "tool_start",
    activity_id: handle.id,
    observed_at_ms: startedAt,
    ...instanceEvidence(),
    tool,
    workspace_id: handle.workspaceId,
    args_sha256: sha256Fingerprint(normalizedArgs),
    args_canonical_bytes: Buffer.byteLength(canonicalArgs, "utf8"),
    args_shape: argumentShape(normalizedArgs),
    ...correlationEvidence(extra)
  });

  const heartbeatMs = heartbeatIntervalMs();
  if (heartbeatMs > 0) {
    handle.heartbeat = setInterval(() => {
      const observedAt = Date.now();
      appendRecord({
        schema: 1,
        event: "tool_heartbeat",
        activity_id: handle.id,
        observed_at_ms: observedAt,
        ...instanceEvidence(),
        elapsed_ms: Math.max(0, observedAt - handle.startedAt),
        tool: handle.tool,
        workspace_id: handle.workspaceId
      });
    }, heartbeatMs);
    handle.heartbeat.unref();
  }

  return handle;
}

export function finishToolActivity(handle: ToolActivityHandle | null, outcome: "ok" | "error"): void {
  if (!handle) return;
  if (handle.heartbeat) clearInterval(handle.heartbeat);
  const finishedAt = Date.now();
  appendRecord({
    schema: 1,
    event: "tool_finish",
    activity_id: handle.id,
    observed_at_ms: finishedAt,
    ...instanceEvidence(),
    duration_ms: Math.max(0, finishedAt - handle.startedAt),
    tool: handle.tool,
    workspace_id: handle.workspaceId,
    outcome
  });
}
