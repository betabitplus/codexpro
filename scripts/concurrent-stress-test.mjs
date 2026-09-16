import http from "node:http";

const port = Number(process.env.PORT || 8787);
const token = process.env.CODEXPRO_TOKEN || "34577acab4ca4cf3c71f6de810074f326fba92bef2660dc3";

function sendToolCall(id, toolName, args, label, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args }
    });
    const started = Date.now();
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/mcp?codexpro_token=" + token,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Content-Length": Buffer.byteLength(data)
      }
    }, (res) => {
      let resBody = "";
      res.on("data", chunk => resBody += chunk);
      res.on("end", () => {
        const duration = Date.now() - started;
        resolve({ label, id, status: res.statusCode, duration, body: resBody });
      });
    });

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`[${label}] HUNG! Exceeded ${timeoutMs}ms without response (collision / deadlock)!`));
    }, timeoutMs);

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`[${label}] Request error: ${err.message}`));
    });

    req.write(data);
    req.end();
  });
}

async function run() {
  console.log("===============================================================");
  console.log("  CODEXPRO CONCURRENCY & COLLISION STRESS TEST");
  console.log("  Target: http://127.0.0.1:" + port);
  console.log("===============================================================\n");

  console.log("--- TEST 1: Overlapping Stateless Tool Calls (Same JSON-RPC ID) ---");
  console.log("Starting slow command (sleep 2s)...");
  const slowPromise = sendToolCall(0, "bash", { command: "sleep 2 && echo slow_done" }, "SLOW-1", 6000);

  await new Promise(r => setTimeout(r, 200));

  console.log("Starting 3 fast commands concurrently while slow command is running...");
  const fast1 = sendToolCall(0, "bash", { command: "echo fast1" }, "FAST-1", 4000);
  const fast2 = sendToolCall(0, "bash", { command: "echo fast2" }, "FAST-2", 4000);
  const fast3 = sendToolCall(0, "bash", { command: "pwd" }, "FAST-3", 4000);

  const results = await Promise.allSettled([slowPromise, fast1, fast2, fast3]);

  let failures = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      console.log(`  ✓ ${r.value.label} completed in ${r.value.duration}ms (status ${r.value.status})`);
    } else {
      console.error(`  ✗ ${r.reason.message}`);
      failures++;
    }
  }

  if (failures > 0) {
    console.error(`\n>>> FAILURE: ${failures} requests hung or failed due to session/stream collision! <<<`);
    process.exit(1);
  } else {
    console.log("\n✓ ALL CONCURRENT REQUESTS RETURNED CLEANLY WITHOUT HANGS!");
  }
}

run().catch(err => {
  console.error("FATAL TEST FAILURE:", err.message);
  process.exit(1);
});
