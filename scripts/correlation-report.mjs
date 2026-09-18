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
    return {
      observed_at_ms: record.observed_at_ms,
      age_seconds: Math.max(0, Math.round((now - record.observed_at_ms) / 1000)),
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
  records: starts
}, null, 2));
