# Postmortem: Streamable HTTP MCP Session Drops & Tunnel Stability

**Date:** 2026-09-06  
**Component:** `src/http.ts` (CodexPro MCP HTTP Server)  
**Commit:** `1acb9eb` (`fix(http): preserve MCP sessions across transport reconnects`)  
**Branch:** `path-rules`

---

## 1. Executive Summary

During real-world workflows with remote AI agents (e.g., ChatGPT Web / CWA interacting with local CodexPro via Tailscale Funnel or reverse proxies), the connection intermittently dropped with:
```text
Connection failed
```
While in the local terminal, `codexpro start` appeared normal with no crashes or error output.

Investigation revealed a critical defect in `src/http.ts`: an aggressive `onclose` handler on `StreamableHTTPServerTransport` was immediately deleting active MCP sessions upon any underlying TCP/SSE connection drop or idle timeout. Removing this premature destruction and delegating session lifecycle to explicit `DELETE /mcp` requests and the pre-existing 30-minute inactivity TTL completely resolved the instability.

---

## 2. Problem Description & Symptoms

* **Symptom 1:** Agent executions intermittently aborted with `Connection failed`, especially during pauses between tool invocations or long-running tasks (e.g., live PTY E2E tests, extensive test suites).
* **Symptom 2:** Local server remained alive, but inspection of HTTP responses showed:
  ```json
  {
    "jsonrpc": "2.0",
    "error": {
      "code": -32001,
      "message": "Session not found"
    },
    "id": null
  }
  ```
* **Symptom 3:** In Tailscale logs, recurring TLS/TCP disconnects were observed:
  ```text
  io.tailscale.ipn.macsys.network-extension: http: TLS handshake error ... EOF
  ```

---

## 3. Root Cause Analysis

### The Flawed Implementation in `src/http.ts`

In `src/http.ts` (line 1697 prior to fix):

```typescript
// BEFORE:
transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  onsessioninitialized: (newSessionId: string) => {
    pruneTransports();
    transports.set(newSessionId, {
      transport,
      createdAt: Date.now(),
      lastSeenAt: Date.now()
    });
    pruneTransports();
  }
} as any);

(transport as any).onclose = () => {
  const closedSessionId = (transport as any).sessionId;
  if (closedSessionId) transports.delete(closedSessionId);
};
```

### Why This Caused Failures

1. **Streamable HTTP Nature:** Under the Model Context Protocol (MCP) Streamable HTTP specification, sessions are stateful across multiple distinct HTTP requests and SSE streams.
2. **Reverse Proxy & Tunnel Timeouts:** Public tunnels (Tailscale Funnel DERP relays, Cloudflare, ngrok) naturally close idle TCP streams or drop connections after ~30–60 seconds of silence.
3. **Premature Session Purge:** When an intermediary closed an idle SSE or HTTP stream, the transport fired `onclose`. The callback immediately deleted `sessionId` from `transports`.
4. **Permanent Disconnect:** The client then sent its next JSON-RPC tool invocation with header `Mcp-Session-Id`. Finding no matching transport, CodexPro returned `404 Session not found`, forcing ChatGPT to abort the conversation.
5. **Architectural Contradiction:** This behavior directly contradicted the server's intended design, which already implemented a 30-minute inactivity TTL (`config.httpSessionTtlMs = 30 * 60_000`) and periodic cleanup via `pruneTransports()`.

---

## 4. The Fix

The aggressive `onclose` handler was removed. Session destruction is now strictly bounded to:
1. **Explicit Client Termination:** Wired via the official `onsessionclosed` option, triggered only when the client explicitly sends a `DELETE /mcp` request.
2. **Inactivity TTL:** Handled by `pruneTransports()`, which automatically prunes sessions that have not received any requests for 30 minutes (`record.lastSeenAt`).

```diff
@@ -1691,14 +1691,12 @@
               lastSeenAt: Date.now()
             });
             pruneTransports();
+          },
+          onsessionclosed: (closedSessionId: string) => {
+            if (closedSessionId) transports.delete(closedSessionId);
           }
         } as any);
 
-        (transport as any).onclose = () => {
-          const closedSessionId = (transport as any).sessionId;
-          if (closedSessionId) transports.delete(closedSessionId);
-        };
-
         const server = createCodexProServer(config);
         await server.connect(transport);
```

---

## 5. Verification & Testing

1. **TypeScript Build:** Compiled cleanly with zero errors (`tsc -p tsconfig.json`).
2. **Smoke Suite:** Passed all 12 MCP functional smoke tests (analysis, CLI, chatgpt-export, skill precedence, import, http, widget, pro, doctor, settings, handoff).
3. **Simulated Disconnect Stress Test:**
   * Initialized an MCP session via `POST /mcp`.
   * Opened a `GET /mcp` SSE stream and abruptly aborted the underlying connection (simulating DERP relay timeout / socket drop).
   * Sent a subsequent `POST /mcp` tool call using the original `Mcp-Session-Id`.
   * **Result:** Server returned `HTTP 200 OK` with the full tool result, proving the session survives socket dropouts.

---

## 6. Related Operational Incidents Encountered

### A. Port 8787 Conflict (`EADDRINUSE`)
* **Cause:** When a foreground terminal session detached abnormally (e.g. terminal tab close or zsh prompt yield without trailing newline `%`), the Node process bypassed `runControlPanel` exit handlers (`q`, `Ctrl+C`). The process was adopted by `launchd` (PID 1) with stdio redirected to `/dev/null`, while child `dist/http.js` held port 8787.
* **Fix:** Identify orphaned processes via `lsof -i :8787` or `ps aux | grep codexpro` and terminate cleanly (`kill -15 <pid>`).

### B. Tailscale Funnel Port 443 Listener Conflict
* **Cause:** Residual state in `tailscaled` from previous manual or interrupted runs triggered:
  `[tailscale] sending serve config: updating config: listener already exists for port 443`
* **Fix:** Reset the serve state prior to launching:
  ```bash
  tailscale serve reset
  ```

### C. macOS Wi-Fi Geolocation Jumps (Electronic Warfare / РЭБ)
* **Cause:** MacBooks lack a hardware GPS receiver and rely on Apple Location Services (`locationd`) using Wi-Fi BSSID triangulation. In active electronic warfare zones, GPS spoofing tricks smartphones (iPhones on the same Wi-Fi), which upload spoofed coordinates to Apple's cloud BSSID database. Additionally, Xiaomi routers broadcast `802.11d Country Code: CN`.
* **Fix:** Disable macOS Location Services in System Settings (`Privacy & Security -> Location Services -> Off`) to force applications to fall back to ISP IP-based geolocation (e.g., Vega Telecom GPON accurately resolving to Dnipro, UA), or append `_nomap` to the router SSID.
