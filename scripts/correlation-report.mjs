import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const defaultFile = process.env.CODEXPRO_CORRELATION_JOURNAL_PATH
  ? path.resolve(process.env.CODEXPRO_CORRELATION_JOURNAL_PATH)
  : path.join(os.homedir(), ".codexpro", "logs", "tool-activity.jsonl");
const filePath = path.resolve(argValue("--file") || defaultFile);
const workspaceFilter = argValue("--workspace");
const toolFilter = argValue("--tool");
const last = Math.max(1, Number(argValue("--last") || 20));

let text;
try {
  text = await fs.readFile(filePath, "utf8");
} catch (error) {
  console.error("Correlation journal unavailable: " + filePath);
  process.exitCode = 2;
  throw error;
}

const records = text
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const serverStarts = records
  .filter((record) => record.event === "server_start")
  .slice(-10)
  .map((record) => ({
    observed_at_ms: record.observed_at_ms,
    server_instance_id: record.server_instance_id ?? null,
    server_pid: record.server_pid ?? null,
    process_started_at_ms: record.process_started_at_ms ?? null,
    host: record.host ?? null,
    port: record.port ?? null,
    default_root: record.default_root ?? null,
    allowed_roots: record.allowed_roots ?? [],
    bash_mode: record.bash_mode ?? null,
    bash_transcript: record.bash_transcript ?? null,
    write_mode: record.write_mode ?? null,
    tool_mode: record.tool_mode ?? null,
    tool_cards: record.tool_cards ?? null,
    codex_sessions: record.codex_sessions ?? null
  }));

const finishes = new Map(
  records
    .filter((record) => record.event === "tool_finish")
    .map((record) => [record.activity_id, record])
);
const heartbeats = new Map();
for (const record of records) {
  if (record.event !== "tool_heartbeat") continue;
  const bucket = heartbeats.get(record.activity_id) ?? [];
  bucket.push(record);
  heartbeats.set(record.activity_id, bucket);
}

function openAiSession(record) {
  return (
    record.header_fingerprints?.["x-openai-session"] ??
    record.meta_fingerprints?.["openai/session"] ??
    record.header_fingerprints?.["x-openai-session-id"] ??
    record.meta_fingerprints?.oai_session_id ??
    null
  );
}

const now = Date.now();
const starts = records
  .filter((record) => record.event === "tool_start")
  .filter((record) => !workspaceFilter || record.workspace_id === workspaceFilter)
  .filter((record) => !toolFilter || record.tool === toolFilter)
  .slice(-last)
  .map((record) => {
    const finish = finishes.get(record.activity_id);
    const activityHeartbeats = heartbeats.get(record.activity_id) ?? [];
    const lastHeartbeat = activityHeartbeats.at(-1);
    const lifecycleInstances = [
      record.server_instance_id,
      ...activityHeartbeats.map((item) => item.server_instance_id),
      finish?.server_instance_id
    ].filter(Boolean);
    const uniqueLifecycleInstances = [...new Set(lifecycleInstances)];
    return {
      observed_at_ms: record.observed_at_ms,
      age_seconds: Math.max(0, Math.round((now - record.observed_at_ms) / 1000)),
      server_instance_id: record.server_instance_id ?? null,
      server_pid: record.server_pid ?? null,
      process_started_at_ms: record.process_started_at_ms ?? null,
      lifecycle_instance_consistent: uniqueLifecycleInstances.length <= 1,
      tool: record.tool,
      workspace_id: record.workspace_id,
      inflight: !finish,
      heartbeat_count: activityHeartbeats.length,
      last_heartbeat_age_seconds: lastHeartbeat
        ? Math.max(0, Math.round((now - lastHeartbeat.observed_at_ms) / 1000))
        : null,
      outcome: finish?.outcome ?? null,
      duration_ms: finish?.duration_ms ?? null,
      args_sha256: record.args_sha256,
      args_canonical_bytes: record.args_canonical_bytes ?? null,
      args_shape: record.args_shape ?? null,
      openai_session_sha256: openAiSession(record),
      request_id_sha256: record.request_id_sha256,
      transport_session_sha256: record.transport_session_sha256,
      header_names: record.header_names ?? [],
      header_fingerprint_keys: Object.keys(record.header_fingerprints ?? {}).sort(),
      meta_paths: record.meta_paths ?? [],
      meta_fingerprint_keys: Object.keys(record.meta_fingerprints ?? {}).sort()
    };
  });

console.log(JSON.stringify({
  journal: filePath,
  server_starts: serverStarts,
  records: starts
}, null, 2));
