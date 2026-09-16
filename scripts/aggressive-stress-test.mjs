import http from "node:http";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const port = Number(process.env.PORT || 8787);
const token = process.env.CODEXPRO_TOKEN || "34577acab4ca4cf3c71f6de810074f326fba92bef2660dc3";

function sendRawMcp(bodyObj, options = {}) {
  const { sessionId, timeoutMs = 15000, abortAfterMs } = options;
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Content-Length": Buffer.byteLength(data)
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;

    const started = Date.now();
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/mcp?codexpro_token=" + token,
      method: "POST",
      headers
    }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        const duration = Date.now() - started;
        let parsed = null;
        try { parsed = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, duration, raw: body, parsed });
      });
    });

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms (hang/deadlock)!`));
    }, timeoutMs);

    if (abortAfterMs) {
      setTimeout(() => {
        req.destroy();
        resolve({ status: 0, duration: abortAfterMs, aborted: true });
      }, abortAfterMs);
    }

    req.on("error", (err) => {
      clearTimeout(timer);
      if (!abortAfterMs) reject(err);
    });

    req.write(data);
    req.end();
  });
}

async function runStatefulClient(i) {
  const client = new Client({ name: "openai-mcp", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?codexpro_token=${token}`));
  const started = Date.now();
  await client.connect(transport);
  const res = await client.callTool({
    name: "bash",
    arguments: { command: "echo stateful_" + i }
  });
  const duration = Date.now() - started;
  await client.close();
  return { label: `STATEFUL-SESS-${i}`, status: 200, duration, raw: JSON.stringify(res) };
}

async function run() {
  console.log("===============================================================================");
  console.log("  CODEXPRO ULTRA-AGGRESSIVE MULTI-CLIENT CONCURRENCY & RESILIENCE TEST");
  console.log("  Target: http://127.0.0.1:" + port);
  console.log("===============================================================================\n");

  // PHASE 1: Active Workspace Continuity Under High Stateless Concurrency
  console.log("--- PHASE 1: Workspace Selection & Cross-Turn Continuity ---");
  const openRes = await sendRawMcp({
    jsonrpc: "2.0",
    id: 0,
    method: "tools/call",
    params: {
      name: "open_workspace",
      arguments: { root: "/Users/stas/Documents/3.Projects/2.Spaces/forked/gptty" }
    }
  });
  assert.equal(openRes.status, 200, "open_workspace failed: " + openRes.raw);
  console.log("  ✓ Successfully opened /Users/stas/Documents/3.Projects/2.Spaces/forked/gptty");

  // PHASE 2: 20-Client Massive Concurrent Wave
  console.log("\n--- PHASE 2: Firing 20 Concurrent Overlapping Requests (Mixed Types & Durations) ---");
  const tasks = [];

  // 4 slow bash tasks (1.5s - 3s)
  tasks.push(sendRawMcp({
    jsonrpc: "2.0", id: 0, method: "tools/call",
    params: { name: "bash", arguments: { command: "sleep 2 && echo slow_1" } }
  }).then(r => ({ label: "SLOW-1 (2s)", ...r })));

  tasks.push(sendRawMcp({
    jsonrpc: "2.0", id: 0, method: "tools/call",
    params: { name: "bash", arguments: { command: "sleep 3 && echo slow_2" } }
  }).then(r => ({ label: "SLOW-2 (3s)", ...r })));

  tasks.push(sendRawMcp({
    jsonrpc: "2.0", id: 0, method: "tools/call",
    params: { name: "bash", arguments: { command: "sleep 1.5 && echo slow_3" } }
  }).then(r => ({ label: "SLOW-3 (1.5s)", ...r })));

  tasks.push(sendRawMcp({
    jsonrpc: "2.0", id: 0, method: "tools/call",
    params: { name: "bash", arguments: { command: "sleep 2.5 && echo slow_4" } }
  }).then(r => ({ label: "SLOW-4 (2.5s)", ...r })));

  // 6 fast bash pwd tasks (each checking that workspace continuity holds!)
  for (let i = 1; i <= 6; i++) {
    tasks.push(sendRawMcp({
      jsonrpc: "2.0", id: 0, method: "tools/call",
      params: { name: "bash", arguments: { command: "pwd" } }
    }).then(r => {
      assert.match(r.raw, /gptty/, `Fast task ${i} lost workspace continuity!`);
      return { label: `FAST-PWD-${i}`, ...r };
    }));
  }

  // 4 file reading tasks
  for (let i = 1; i <= 4; i++) {
    tasks.push(sendRawMcp({
      jsonrpc: "2.0", id: 0, method: "tools/call",
      params: { name: "read", arguments: { path: "README.md", start_line: 1, end_line: 20 } }
    }).then(r => ({ label: `READ-FILE-${i}`, ...r })));
  }

  // 3 stateful session tasks (with real MCP SDK clients connecting & initializing concurrently)
  for (let i = 1; i <= 3; i++) {
    tasks.push(runStatefulClient(i));
  }

  // 3 interleaved git_status calls
  for (let i = 1; i <= 3; i++) {
    tasks.push(sendRawMcp({
      jsonrpc: "2.0", id: 0, method: "tools/call",
      params: { name: "git_status", arguments: {} }
    }).then(r => ({ label: `GIT-STATUS-${i}`, ...r })));
  }

  console.log(`  Dispatched ${tasks.length} requests simultaneously into the server...`);
  const results = await Promise.allSettled(tasks);

  let successCount = 0;
  let failCount = 0;
  for (const res of results) {
    if (res.status === "fulfilled") {
      const r = res.value;
      if (r.status === 200) {
        console.log(`    ✓ ${r.label.padEnd(20)} finished in ${r.duration}ms (status ${r.status})`);
        successCount++;
      } else {
        console.error(`    ✗ ${r.label.padEnd(20)} returned non-200: ${r.status} - ${r.raw.slice(0, 80)}`);
        failCount++;
      }
    } else {
      console.error(`    ✗ FAILED / HUNG: ${res.reason.message}`);
      failCount++;
    }
  }

  assert.equal(failCount, 0, `Phase 2 had ${failCount} failures!`);
  console.log(`  ✓ All ${successCount} concurrent requests succeeded cleanly!\n`);

  // PHASE 3: Rapid Abort & Immediate Reuse (Simulating ChatGPT Stop button)
  console.log("--- PHASE 3: Simulating Client Abort / Stop Generation & Immediate Follow-up ---");
  console.log("  Starting a 4-second command and aborting connection at 150ms...");
  await sendRawMcp({
    jsonrpc: "2.0", id: 0, method: "tools/call",
    params: { name: "bash", arguments: { command: "sleep 4 && echo unreached" } }
  }, { abortAfterMs: 150 });
  console.log("  ✓ Connection aborted by client as expected.");

  console.log("  Immediately issuing new tool call on the same port...");
  const followUp = await sendRawMcp({
    jsonrpc: "2.0", id: 0, method: "tools/call",
    params: { name: "bash", arguments: { command: "echo alive_and_responsive" } }
  });
  assert.equal(followUp.status, 200);
  assert.match(followUp.raw, /alive_and_responsive/);
  console.log(`  ✓ Follow-up succeeded in ${followUp.duration}ms! Server is responsive and healthy!\n`);

  console.log("===============================================================================");
  console.log("  ★★★ ALL ULTRA-AGGRESSIVE STRESS TESTS PASSED WITH 100% SUCCESS! ★★★");
  console.log("===============================================================================");
}

run().catch(err => {
  console.error("\n>>> AGGRESSIVE STRESS TEST FAILED! <<<\n", err);
  process.exit(1);
});
