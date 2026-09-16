import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function getFreePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function waitForHealth(url, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      http.get(url, (res) => {
        if (res.statusCode === 200) resolve();
        else retry();
      }).on("error", retry);
    }
    function retry() {
      if (Date.now() - start > timeoutMs) reject(new Error("Timeout waiting for server"));
      else setTimeout(check, 100);
    }
    check();
  });
}

async function run() {
  const defaultRoot = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-cont-default-")));
  const projectRoot = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-cont-project-")));
  await fsp.writeFile(path.join(projectRoot, "marker.txt"), "project root content\n", "utf8");

  const port = await getFreePort();
  const token = "continuity-test-token-1234567890";
  console.log("Starting CodexPro HTTP server on port", port);
  let proc = spawn("node", [
    "dist/http.js",
    "--root", defaultRoot,
    "--allow-home",
    "--tool-mode", "full",
    "--port", String(port),
    "--token", token
  ], { stdio: "inherit", env: { ...process.env, CODEXPRO_HTTP_TOKEN: token, CODEXPRO_ALLOWED_ROOTS: [defaultRoot, projectRoot].join(path.delimiter) } });

  await waitForHealth("http://127.0.0.1:" + port + "/healthz?codexpro_token=" + token);
  const mcpUrl = "http://127.0.0.1:" + port + "/mcp?codexpro_token=" + token;

  try {
    // Turn 1: Client 1 (openai-mcp) opens projectRoot
    console.log("=== Turn 1: OpenAI MCP Client 1 opens projectRoot ===");
    const client1 = new Client({ name: "openai-mcp", version: "1.0.0" });
    const transport1 = new StreamableHTTPClientTransport(new URL(mcpUrl));
    await client1.connect(transport1);
    const openRes = await client1.callTool({
      name: "open_workspace",
      arguments: { root: projectRoot }
    });
    console.log("Turn 1 open_workspace result:", openRes.structuredContent.workspace_id);
    assert.equal(openRes.structuredContent.root, projectRoot);
    const projectWsId = openRes.structuredContent.workspace_id;
    await client1.close();

    // Turn 2: Client 2 (openai-mcp on next turn, fresh session) calls bash pwd without workspace_id
    console.log("=== Turn 2: OpenAI MCP Client 2 (new turn/session) calls bash pwd without workspace_id ===");
    const client2 = new Client({ name: "openai-mcp", version: "1.0.0" });
    const transport2 = new StreamableHTTPClientTransport(new URL(mcpUrl));
    await client2.connect(transport2);
    const pwdRes = await client2.callTool({
      name: "bash",
      arguments: { command: "pwd" }
    });
    console.log("Turn 2 bash pwd stdout:", pwdRes.structuredContent.stdout.trim());
    assert.equal(pwdRes.structuredContent.stdout.trim(), projectRoot);
    await client2.close();

    // Turn 3: Restart server completely to test disk runtime revival
    console.log("=== Turn 3: Restarting server to test disk persistence ===");
    proc.kill();
    await new Promise((r) => setTimeout(r, 600));

    proc = spawn("node", [
      "dist/http.js",
      "--root", defaultRoot,
      "--allow-home",
      "--tool-mode", "full",
      "--port", String(port),
      "--token", token
    ], { stdio: "inherit", env: { ...process.env, CODEXPRO_HTTP_TOKEN: token, CODEXPRO_ALLOWED_ROOTS: [defaultRoot, projectRoot].join(path.delimiter) } });
    await waitForHealth("http://127.0.0.1:" + port + "/healthz?codexpro_token=" + token);

    // Turn 4: Client 3 on newly restarted server calls bash pwd without workspace_id
    console.log("=== Turn 4: Client 3 on fresh server calls bash pwd without workspace_id ===");
    const client3 = new Client({ name: "openai-mcp", version: "1.0.0" });
    const transport3 = new StreamableHTTPClientTransport(new URL(mcpUrl));
    await client3.connect(transport3);
    const restartPwdRes = await client3.callTool({
      name: "bash",
      arguments: { command: "pwd" }
    });
    console.log("Turn 4 bash pwd after restart stdout:", restartPwdRes.structuredContent.stdout.trim());
    assert.equal(restartPwdRes.structuredContent.stdout.trim(), projectRoot);

    // Also call with explicit workspace_id to verify revived lookup
    const idCallRes = await client3.callTool({
      name: "bash",
      arguments: { command: "pwd", workspace_id: projectWsId }
    });
    assert.equal(idCallRes.structuredContent.stdout.trim(), projectRoot);
    await client3.close();

    // Turn 5: Client 4 with smoke test client name should be isolated
    console.log("=== Turn 5: Isolated test client connects ===");
    const client4 = new Client({ name: "codexpro-http-smoke", version: "1.0.0" });
    const transport4 = new StreamableHTTPClientTransport(new URL(mcpUrl));
    await client4.connect(transport4);
    const listRes = await client4.callTool({ name: "list_workspaces", arguments: {} });
    const text = listRes.content.find(p => p.type === "text")?.text ?? "";
    console.log("Turn 5 list_workspaces text:", text);
    assert.match(text, new RegExp(defaultRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ".*selected"));
    assert.doesNotMatch(text, new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ".*selected"));
    await client4.close();

    console.log("✓ workspace continuity smoke test passed");
  } finally {
    proc.kill();
    await fsp.rm(defaultRoot, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
