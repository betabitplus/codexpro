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

---

## 7. Incident: Tailscale Funnel DERP Idle Disconnects (75s) & Keepalive Solution

**Date:** 2026-09-06  
**Component:** `scripts/codexpro.mjs` (CodexPro CLI Runner)  
**Commit:** `b7709d8` (`fix(tunnel): add active tunnel keepalive to prevent DERP idle disconnects and TLS EOF`)  
**Branch:** `path-rules`

### The Problem

Even with the transport session fix (`1acb9eb`), remote AI agents in ChatGPT Web continued to experience intermittent `Connection failed` errors. Specifically:
* Commands executed in rapid succession succeeded without issue.
* As soon as the agent paused for >1–2 minutes (thinking, generating a long response, or waiting for user input), the very next tool call failed with `Connection failed`.
* Inspection of the local terminal showed no errors, but unified system logs (`io.tailscale.ipn.macsys.network-extension`) revealed:
  ```text
  magicsock: closing connection to derp-4 (idle), age 1m15s
  ...
  http: TLS handshake error from [fd7a:115c:a1e0::f701:f79c]:33814: EOF
  magicsock: adding connection to derp-4 for [ZzXTg]
  magicsock: derp-4 connected; connGen=1
  ```

### Root Cause Analysis

1. **NAT Traversal Constraints:** `tailscale netcheck` reported `PortMapping: none` (UPnP/NAT-PMP disabled on local router). Consequently, direct WireGuard UDP peer-to-peer connections to Tailscale Funnel edge ingress nodes could not be established; all ingress traffic had to flow through the nearest DERP relay (`derp-4` in Frankfurt).
2. **Aggressive DERP Idle Reaper:** Tailscale client daemon implements an idle connection reaper that closes connections to DERP relays after exactly 75 seconds (`1m15s`) of inactivity (`magicsock: closing connection to derp-4 (idle)`).
3. **TLS Handshake Race on Reconnection:** When an external request hits the Funnel edge ingress while DERP-4 is closed, the edge proxy initiates a connection. The local daemon detects the packet and opens a new connection to `derp-4` (~150–300ms). However, the remote client (or edge proxy) TLS handshake deadline expires first, resulting in `TLS handshake error: EOF` and an immediate `Connection failed` in ChatGPT Web.
4. **Aggravating Factors:** Two orphaned background processes were pinning 2 CPU cores at 100% on a machine running in macOS Low Power Mode (`lowpowermode 1`), delaying DERP reconnection routines.

### The Fix

1. **Native Tunnel Keepalive:** In `scripts/codexpro.mjs`, implemented `startTunnelKeepAlive(url, token, verbose, 20000)`. When any public tunnel (`tailscale`, `cloudflare`, `ngrok`) is started, a background heartbeat probe is dispatched every 20 seconds to `${publicBase}/healthz` with the auth token.
   * **Why 20s:** It sits well below the 75s DERP idle timeout and standard NAT router connection tracking timeouts, preventing DERP-4 from ever transitioning to an idle state.
   * **Non-blocking:** Probes run with an unref-ed timer and AbortController timeout (8s), with concurrent execution locks (`inFlight`) to avoid queue pileup.
   * **Clean Teardown:** Hooked into the CLI `cleanup()` sequence (`stopTunnelKeepAlive()`) so that process termination remains clean.
2. **Official macOS Tailscale Binary Preference:** Updated `resolveTailscale` to check `/Applications/Tailscale.app/Contents/MacOS/Tailscale` on macOS before falling back to PATH, preventing CLI/daemon version mismatch warnings (`teb67e5dcb` vs `t6cac91817`).
3. **Process Hygiene:** Terminated orphaned runaway processes and verified normal system load.

### Verification

* **Controlled Idle Test:** Without keepalive, DERP-4 reliably closed at 75s of silence (`age 1m15s`), followed by TLS handshake errors.
* **Keepalive Stress Test:** Ran a 3-minute keepalive series with 20s intervals over the public endpoint `https://macbook-pro-stas.tail64004b.ts.net/healthz`. 100% of probes succeeded with 0.33–0.50s latency, with zero DERP disconnects and zero TLS handshake errors in system logs.
* **Smoke Suite:** Verified `npm run path-rules:verify` passed all 12 smoke test suites.


---

## 8. Stale Edge Ingress Desynchronization (`SSL_ERROR_SYSCALL`) & CLI Self-Healing

### Symptoms Observed

* User restarted `codexpro start` and observed:
  ```text
  OK Local MCP ready at http://127.0.0.1:8787/mcp
  OK Tailscale Funnel already active for https://macbook-pro-stas.tail64004b.ts.net
  CodexPro ready
  [server running] codexpro>
  ```
* But remote calls to `https://macbook-pro-stas.tail64004b.ts.net` failed immediately:
  ```text
  * LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to macbook-pro-stas.tail64004b.ts.net:443
  curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to macbook-pro-stas.tail64004b.ts.net:443
  ```
* Additionally, the interactive prompt `codexpro>` was mistaken for a stalled process or input prompt, and Node.js logged a deprecation warning `[DEP0190] Passing args to a shell is deprecated`.

### Root Cause Analysis

1. **Coordination Server Edge Ingress Desync:**
   Repeated restarts and background serve state cached in the macOS Keychain (`tailscale-serve/c060`) caused the local `tailscaled` daemon to believe Funnel was active (`AllowFunnel: true`). However, the Tailscale coordination server sent `Hostinfo.IngressEnabled: false` / `invalid-packet-filter` to the edge ingress proxies (`185.40.234.x`). When external clients connected to the edge proxies on port 443, the edge proxies immediately reset the connection on Client Hello (`SSL_ERROR_SYSCALL`).
2. **Missing Self-Healing in CLI:**
   When `isTailscaleFunnelActive()` detected a pre-existing funnel config, it simply assumed the funnel was healthy. If the funnel was broken or desynchronized, it hung during startup health checks or failed without attempting to reset.
3. **DEP0190 Deprecation Warning:**
   In Node 22+, `commandExists()` called `spawnSync(..., { shell: true })` with args, triggering `[DEP0190]`.
4. **Prompt Ambiguity:**
   The interactive control panel prompt `codexpro>` did not explicitly state that the server was actively running in the background.

### The Fix

1. **Edge Resynchronization & Self-Healing:**
   * Executed `tailscale funnel reset` followed by `tailscale funnel --bg 8787` to force full coordination server re-registration.
   * In `scripts/codexpro.mjs`, when `alreadyServing` is detected, the CLI performs a fast 5s probe against `${publicBase}/healthz`. If unresponsive, it automatically logs a warning, resets the funnel (`tailscale funnel reset`), and re-provisions a fresh funnel.
2. **Safe Log Tail Reference:**
   * Replaced `cloudflared.codexproLogTail` with optional chaining `cloudflared?.codexproLogTail` to prevent `TypeError` if `cloudflared` process handle is undefined.
3. **Eliminated DEP0190:**
   * Updated `commandExists()` to use `commandPaths(command).length > 0` which avoids passing arguments to a shell.
4. **Clarified Server State in UI:**
   * Changed interactive prompt from `codexpro> ` to `[server running] codexpro> ` and added clear status banner indicating that the server is live in background and no keyboard input is required.

### Verification

* `curl -v -H "Authorization: Bearer $(cat ~/.codexpro/http-token)" https://macbook-pro-stas.tail64004b.ts.net/healthz` -> `HTTP/2 200 OK`.
* Full MCP initialization POST over public Funnel returned `HTTP/2 200` with JSON-RPC initialize response and session ID.
* Verified no `[DEP0190]` warnings and clean `npm run doctor` output.
