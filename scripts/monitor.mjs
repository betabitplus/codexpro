import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const logPath = path.join(os.homedir(), ".codexpro", "logs", "codexpro.log");
const statusPath = path.join(os.homedir(), ".codexpro", "monitor-status.json");

if (!fs.existsSync(logPath)) {
  console.error("Log file not found at " + logPath);
  process.exit(1);
}

console.log("===============================================================");
console.log("  CODEXPRO MCP REAL-TIME TRAFFIC & HANG MONITOR");
console.log("  Watching: " + logPath);
console.log("  Status file: " + statusPath);
console.log("===============================================================\n");

const inFlight = new Map();
let totalCompleted = 0;
let totalDisconnects = 0;
let totalHangs = 0;
let lastHungRequest = null;

function saveStatus() {
  const now = Date.now();
  const activeList = [];
  let maxElapsed = 0;

  for (const [key, req] of inFlight.entries()) {
    const elapsed = Math.round((now - req.started) / 1000);
    if (elapsed > maxElapsed) maxElapsed = elapsed;
    activeList.push({
      key,
      tool: req.tool,
      session: req.session,
      args: req.args,
      elapsedSeconds: elapsed
    });
  }

  let health = "HEALTHY";
  if (maxElapsed > 30) health = "CRITICAL_HANG";
  else if (maxElapsed > 10) health = "WARNING_SLOW";

  const status = {
    updatedAt: new Date().toISOString(),
    health,
    activeRequestsCount: activeList.length,
    longestRunningSeconds: maxElapsed,
    activeRequests: activeList,
    totalCompleted,
    totalDisconnects,
    totalHangs,
    lastHungRequest
  };

  try {
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + "\n", "utf8");
  } catch {}
}

function processLine(line) {
  if (!line.trim()) return;

  const callMatch = line.match(/\[(.*?)\] \[(?:codexpro|mcp)\] Calling tool: (\w+)(?: session=([^\s]+))?(?: args=(.*))?/);
  if (callMatch) {
    const [_, ts, tool, session, args] = callMatch;
    const reqObj = {
      key: (session || "stateless") + ":" + tool,
      started: Date.now(),
      tool,
      session: session || "stateless",
      args: args ? args.slice(0, 160) : ""
    };
    inFlight.set(tool, reqObj);
    console.log("[START] " + tool + " (" + reqObj.session + ") " + reqObj.args);
    saveStatus();
    return;
  }

  const compMatch = line.match(/\[(.*?)\] \[(?:codexpro|mcp)\] Tool (\w+) completed in (\d+)ms/);
  if (compMatch) {
    const [_, ts, tool, durationMs] = compMatch;
    const duration = Number(durationMs);
    inFlight.delete(tool);
    totalCompleted++;
    console.log("[DONE] " + tool + " completed in " + duration + "ms");
    saveStatus();
    return;
  }

  if (line.includes("[client disconnected]")) {
    const durMatch = line.match(/\((\d+)ms/);
    const dur = durMatch ? Number(durMatch[1]) : 0;
    totalDisconnects++;
    if (dur > 20000) {
      totalHangs++;
      lastHungRequest = { timestamp: new Date().toISOString(), line, durationMs: dur };
      console.error("[CRITICAL DROP/TIMEOUT] Client disconnected after " + Math.round(dur / 1000) + "s! Line: " + line);
    } else {
      console.log("[DISCONNECT] Client closed socket after " + dur + "ms");
    }
    saveStatus();
    return;
  }

  if (line.includes("[http:error]") || line.includes("[mcp:error]")) {
    console.error("[ERROR] " + line);
    saveStatus();
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [tool, req] of inFlight.entries()) {
    const elapsed = Math.round((now - req.started) / 1000);
    if (elapsed >= 25 && elapsed % 10 === 0) {
      console.error("[HANG WARNING] Tool " + tool + " running for " + elapsed + "s without completion! Args: " + req.args);
    } else if (elapsed >= 10 && elapsed % 10 === 0) {
      console.warn("[SLOW IN-FLIGHT] Tool " + tool + " running for " + elapsed + "s...");
    }
  }
  saveStatus();
}, 2000);

let fileSize = fs.statSync(logPath).size;
const startOffset = Math.max(0, fileSize - 15000);
const initBuf = Buffer.alloc(fileSize - startOffset);
const fd = fs.openSync(logPath, "r");
fs.readSync(fd, initBuf, 0, initBuf.length, startOffset);
fs.closeSync(fd);
const lines = initBuf.toString("utf8").split("\n");
for (const line of lines.slice(-15)) {
  processLine(line);
}

fs.watch(logPath, (eventType) => {
  if (eventType === "change") {
    try {
      const newSize = fs.statSync(logPath).size;
      if (newSize > fileSize) {
        const diff = newSize - fileSize;
        const buf = Buffer.alloc(diff);
        const f = fs.openSync(logPath, "r");
        fs.readSync(f, buf, 0, diff, fileSize);
        fs.closeSync(f);
        fileSize = newSize;
        const newLines = buf.toString("utf8").split("\n");
        for (const l of newLines) processLine(l);
      } else if (newSize < fileSize) {
        fileSize = newSize;
      }
    } catch {}
  }
});
