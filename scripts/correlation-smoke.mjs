import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  beginToolActivity,
  finishToolActivity,
  sha256Fingerprint
} from "../dist/correlation.js";

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
    server.on("error", reject);
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("timeout waiting for HTTP server\n" + stderr)), 15000);
    timer.unref();
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.includes("HTTP MCP listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("HTTP server exited before listening: " + code + "\n" + stderr));
    });
  });
}

async function readJsonl(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function directRecorderSmoke(tempDir) {
  const journal = path.join(tempDir, "direct.jsonl");
  process.env.CODEXPRO_CORRELATION_JOURNAL_PATH = journal;
  process.env.CODEXPRO_CORRELATION_HEARTBEAT_MS = "40";

  const rawAuthorization = "Bearer " + "a".repeat(32);
  const rawCookie = "session=" + "b".repeat(24);
  const rawOaiSession = "oai-session-" + "c".repeat(12);
  const rawRequestId = "request-" + "d".repeat(12);
  const rawTurn = "turn-" + "e".repeat(12);
  const rawInvocation = "invocation-" + "f".repeat(12);
  const rawMetaAuthorization = "meta-" + "g".repeat(24);

  const args = { z: 2, workspace_id: "ws_direct", a: 1 };
  const handle = beginToolActivity("read", args, {
    requestId: 42,
    sessionId: "transport-direct",
    requestInfo: {
      headers: {
        authorization: rawAuthorization,
        cookie: rawCookie,
        "x-openai-session-id": rawOaiSession,
        "x-request-id": rawRequestId,
        traceparent: "00-direct-trace-01"
      }
    },
    _meta: {
      oai_session_id: rawOaiSession,
      turn_exchange_id: rawTurn,
      invocation_uuid: rawInvocation,
      authorization: rawMetaAuthorization,
      progressToken: "progress-" + "h".repeat(16)
    }
  });
  assert.ok(handle);
  await new Promise((resolve) => setTimeout(resolve, 130));
  const beforeFinishRecords = await readJsonl(journal);
  const heartbeatCountBeforeFinish = beforeFinishRecords.filter(
    (record) => record.event === "tool_heartbeat" && record.activity_id === handle.id
  ).length;
  assert.ok(heartbeatCountBeforeFinish >= 2, "expected heartbeat events while tool is in flight");

  finishToolActivity(handle, "ok");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterFinishRecords = await readJsonl(journal);
  const heartbeatCountAfterFinish = afterFinishRecords.filter(
    (record) => record.event === "tool_heartbeat" && record.activity_id === handle.id
  ).length;
  assert.equal(
    heartbeatCountAfterFinish,
    heartbeatCountBeforeFinish,
    "heartbeat timer must stop immediately after tool finish"
  );

  const text = await fs.readFile(journal, "utf8");
  for (const rawValue of [
    rawAuthorization,
    rawCookie,
    rawOaiSession,
    rawRequestId,
    rawTurn,
    rawInvocation,
    rawMetaAuthorization
  ]) {
    assert.equal(text.includes(rawValue), false, "journal leaked a raw value");
  }

  const records = await readJsonl(journal);
  const start = records.find((record) => record.event === "tool_start");
  assert.ok(start);
  assert.equal(start.workspace_id, "ws_direct");
  assert.equal(start.header_fingerprints["x-openai-session-id"], sha256Fingerprint(rawOaiSession));
  assert.equal(start.header_fingerprints["x-request-id"], sha256Fingerprint(rawRequestId));
  assert.equal(start.header_fingerprints.authorization, undefined);
  assert.equal(start.header_fingerprints.cookie, undefined);
  assert.equal(start.meta_fingerprints.oai_session_id, sha256Fingerprint(rawOaiSession));
  assert.equal(start.meta_fingerprints.turn_exchange_id, sha256Fingerprint(rawTurn));
  assert.equal(start.meta_fingerprints.invocation_uuid, sha256Fingerprint(rawInvocation));
  assert.equal(start.meta_fingerprints.authorization, undefined);
  assert.equal(start.meta_fingerprints.progressToken, undefined);
  assert.equal(
    sha256Fingerprint({ b: 2, a: 1 }),
    sha256Fingerprint({ a: 1, b: 2 }),
    "stable arg hashing must ignore object key order"
  );
  const mode = (await fs.stat(journal)).mode & 0o777;
  assert.equal(mode, 0o600, "correlation journal must be owner-only");
  delete process.env.CODEXPRO_CORRELATION_HEARTBEAT_MS;
}

async function callCanary(baseUrl, credential, sessionValue, requestValue, metaTurn, metaInvocation) {
  const client = new Client({ name: "codexpro-correlation-smoke", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl + "/mcp"), {
    requestInit: {
      headers: {
        Authorization: "Bearer " + credential,
        Cookie: "session=" + "i".repeat(24),
        "X-OpenAI-Session-Id": sessionValue,
        "X-Request-Id": requestValue,
        Traceparent: "00-integration-trace-" + sessionValue
      }
    }
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "open_current_workspace",
      arguments: { include_tree: false },
      _meta: {
        oai_session_id: sessionValue,
        turn_exchange_id: metaTurn,
        invocation_uuid: metaInvocation,
        authorization: "meta-" + "j".repeat(24),
        progressToken: "progress-" + "k".repeat(16)
      }
    });
    assert.notEqual(result.isError, true);
  } finally {
    await client.close();
  }
}

async function httpCanarySmoke(tempDir) {
  const root = await fs.mkdtemp(path.join(tempDir, "root-"));
  const home = await fs.mkdtemp(path.join(tempDir, "home-"));
  const journal = path.join(tempDir, "http.jsonl");
  const port = await getFreePort();
  const credential = "x".repeat(32);
  const baseUrl = "http://127.0.0.1:" + port;

  const child = spawn("node", ["dist/http.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      CODEXPRO_ROOT: root,
      CODEXPRO_ALLOWED_ROOTS: root,
      CODEXPRO_HOST: "127.0.0.1",
      CODEXPRO_PORT: String(port),
      CODEXPRO_HTTP_TOKEN: credential,
      CODEXPRO_BASH_MODE: "off",
      CODEXPRO_WRITE_MODE: "off",
      CODEXPRO_TOOL_MODE: "minimal",
      CODEXPRO_TOOL_CARDS: "0",
      CODEXPRO_HOME: home,
      CODEXPRO_CORRELATION_JOURNAL_PATH: journal
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const sessionA = "oai-session-" + "l".repeat(12);
  const sessionB = "oai-session-" + "m".repeat(12);
  const requestA = "request-" + "n".repeat(12);
  const requestB = "request-" + "o".repeat(12);
  const turnA = "turn-" + "p".repeat(12);
  const turnB = "turn-" + "q".repeat(12);
  const invocationA = "invocation-" + "r".repeat(12);
  const invocationB = "invocation-" + "s".repeat(12);

  try {
    await waitForListening(child);
    await callCanary(baseUrl, credential, sessionA, requestA, turnA, invocationA);
    await callCanary(baseUrl, credential, sessionB, requestB, turnB, invocationB);
    const concurrentSessions = Array.from({ length: 6 }, (_, index) => "oai-session-concurrent-" + index);
    await Promise.all(
      concurrentSessions.map((sessionValue, index) =>
        callCanary(
          baseUrl,
          credential,
          sessionValue,
          "request-concurrent-" + index,
          "turn-concurrent-" + index,
          "invocation-concurrent-" + index
        )
      )
    );

    const text = await fs.readFile(journal, "utf8");
    const concurrentRawValues = concurrentSessions.flatMap((sessionValue, index) => [
      sessionValue,
      "request-concurrent-" + index,
      "turn-concurrent-" + index,
      "invocation-concurrent-" + index
    ]);
    for (const rawValue of [
      credential,
      sessionA,
      sessionB,
      requestA,
      requestB,
      turnA,
      turnB,
      invocationA,
      invocationB,
      ...concurrentRawValues
    ]) {
      assert.equal(text.includes(rawValue), false, "HTTP journal leaked a raw value");
    }

    const records = await readJsonl(journal);
    const starts = records.filter(
      (record) => record.event === "tool_start" && record.tool === "open_current_workspace"
    );
    assert.equal(starts.length, 8);
    const observedSessionFingerprints = new Set(
      starts.map((record) => record.header_fingerprints["x-openai-session-id"])
    );
    assert.equal(observedSessionFingerprints.size, 8);
    assert.equal(
      starts[0].header_fingerprints["x-openai-session-id"],
      sha256Fingerprint(sessionA)
    );
    assert.equal(
      starts[1].header_fingerprints["x-openai-session-id"],
      sha256Fingerprint(sessionB)
    );
    assert.notEqual(
      starts[0].header_fingerprints["x-openai-session-id"],
      starts[1].header_fingerprints["x-openai-session-id"]
    );
    assert.equal(starts[0].meta_fingerprints.turn_exchange_id, sha256Fingerprint(turnA));
    assert.equal(starts[1].meta_fingerprints.turn_exchange_id, sha256Fingerprint(turnB));
    assert.ok(starts[0].header_names.includes("authorization"));
    assert.ok(starts[0].header_names.includes("cookie"));
    assert.equal(starts[0].header_fingerprints.authorization, undefined);
    assert.equal(starts[0].header_fingerprints.cookie, undefined);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-correlation-smoke-"));
try {
  await directRecorderSmoke(tempDir);
  await httpCanarySmoke(tempDir);
  console.log("correlation smoke passed");
} finally {
  delete process.env.CODEXPRO_CORRELATION_JOURNAL_PATH;
  await fs.rm(tempDir, { recursive: true, force: true });
}
