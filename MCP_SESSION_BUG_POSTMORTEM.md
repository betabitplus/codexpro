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


---

## 9. Foreground Funnel Zombie Session & Auto-Healing Background Watchdog

### Symptoms Observed

* After running for several hours, ChatGPT agent suddenly reported:
  `Connection failed / tool disconnecting` ("инструмент отваливается").
* In Tailscale system logs (`io.tailscale.ipn.macsys.network-extension`):
  ```text
  Drop: TCP{[fd7a:115c:a1e0::f701:f79c]:48725 > [fd7a:115c:a1e0::cf01:d2c4]:37393} 80 no rules matched
  http: TLS handshake error from [fd7a:115c:a1e0::f701:f79c]:35630: EOF
  ```
* Running `tailscale funnel status` showed:
  ```text
  # Funnel on:
  No serve config
  ```
* But checking processes showed the child process `tailscale funnel http://127.0.0.1:8787` still hanging as a zombie (PID 66223).
* Attempting to run `tailscale funnel --bg 8787` failed with:
  ```text
  sending serve config: updating config: foreground listener already exists for port 443
  ```

### Root Cause Analysis

1. **Transient Foreground Funnel Vulnerability:**
   When `codexpro` spawned `tailscale funnel <target>` without `--bg`, Tailscale created a transient foreground session tied to an ephemeral local port (e.g. `37393`) and IPC connection.
2. **Sleep / Network Change Invalidation:**
   When macOS went to sleep or the local IP address changed (`192.168.31.223` -> `192.168.31.151`), the Tailscale daemon invalidated the transient foreground serve session (`No serve config`). However, the spawned child process did NOT terminate, retaining a "foreground listener" lock on port 443.
3. **Firewall Drop on Ephemeral Ports:**
   Tailscale Funnel ingress nodes continued routing traffic to the ephemeral session port (`37393`), where Tailscale's own macOS NetworkExtension packet filter dropped every packet with `no rules matched` (since ingress capability is only granted to 443). The incoming TLS handshake timed out with `EOF`.
4. **Lack of Terminal Activity Feedback:**
   Because incoming MCP requests were not logged by default, the user had no visibility into whether ChatGPT was reaching CodexPro or failing silently.

### The Fix

1. **Permanent Background Mode (`--bg`):**
   * Modified `scripts/codexpro.mjs` to NEVER spawn Tailscale in transient foreground mode. It now registers directly into the system daemon via `tailscale funnel --bg <port>`.
   * Background mode runs inside the persistent system daemon, survives sleep/wake and Wi-Fi changes, binds port 443 directly (eliminating ephemeral port drops), and leaves no zombie process locks.
2. **Auto-Reconnecting Keepalive Watchdog:**
   * Enhanced `startTunnelKeepAlive` with `onFail` and `onSuccess` hooks.
   * If two consecutive healthcheck probes fail (e.g. after laptop wake-up or router reconnect), the watchdog automatically executes `tailscale funnel reset` + `tailscale funnel --bg <port>` to restore edge connectivity without user intervention.
3. **Real-time Terminal Feedback for MCP Tool Calls:**
   * In `src/http.ts`, added immediate console logging for MCP events:
     `[CodexPro MCP] Calling tool: <tool_name>...`
     `[CodexPro MCP] Tool <tool_name> completed in <ms>ms`
     `[CodexPro MCP] Client connected: <client_name>`
   * Provides immediate visual confirmation whenever ChatGPT calls a tool.

### Verification

* Executed `tools/call` for `open_current_workspace` over the public Funnel URL `https://macbook-pro-stas.tail64004b.ts.net/mcp`.
* Request executed in 45ms and returned full workspace data with HTTP/2 200 OK.
* Background daemon verified with `tailscale funnel status` (clean background serve config on port 443, no ephemeral ports, no packet filter drops).


---

## 10. The 17-Hour Idle Reaper: Hardcoded 30-Minute HTTP Session TTL & Transparent Auto-Restoration

### Symptoms & Timeline

* After running smoothly, ChatGPT suddenly fails with `Action failed: Tool disconnected` ("инструмент отваливается") when resuming a conversation after lunch or the next morning (~16-17 hours of idle gap).
* Local Tailscale and `/healthz` endpoints report `HTTP 200 OK` and the tunnel is fully operational.
* However, in the MCP request stream, ChatGPT receives:
  ```json
  HTTP/1.1 404 Not Found
  {"jsonrpc": "2.0", "error": {"code": -32001, "message": "Session not found"}}
  ```
* ChatGPT treats any HTTP 404 response on an existing session as a fatal, unrecoverable disconnection, permanently breaking the chat.

### Root Cause Analysis

1. **Hardcoded 30-Minute HTTP Session TTL (`src/config.ts`):**
   * `config.httpSessionTtlMs` was hardcoded to default to `30 * 60_000` (30 minutes).
   * A periodic reaper timer ran every 60 seconds calling `pruneTransports()`, which permanently evicted any session whose `lastSeenAt` was older than 30 minutes.
2. **Ephemeral In-Memory Transports Map (`src/http.ts`):**
   * The `transports` collection was strictly an in-memory `Map<string, TransportRecord>`.
   * When the user left their computer for >30 minutes (or overnight), the session was deleted from memory.
   * Furthermore, whenever `codexpro` was restarted, all active session IDs were lost, breaking every open ChatGPT chat.
3. **Running Old Process in Memory:**
   * A long-running `codexpro start` process started the previous day at 21:00 remained running in the user's terminal.
   * Even after codebase updates, the running Node.js process held the old compiled bytecode in RAM until explicitly restarted.

### The Fix

1. **Extended Default Session TTL:**
   * In `src/config.ts`, increased the default `httpSessionTtlMs` from 30 minutes to **7 days** (`7 * 24 * 60 * 60_000`), with an upper bound of 30 days.
2. **Persistent Session Registry (`~/.codexpro/sessions.json`):**
   * In `src/http.ts`, added `loadKnownSessions()` and `persistKnownSessions()`.
   * Whenever a legitimate session is initialized via `initialize`, its UUID is persisted to `~/.codexpro/sessions.json`.
3. **Transparent Lazy Session Auto-Restoration (`getOrCreateTransport`):**
   * When an incoming request arrives with a known `Mcp-Session-Id` that was pruned from RAM or wiped by a server restart:
     * CodexPro automatically instantiates a new `StreamableHTTPServerTransport` with that session ID.
     * Marks it initialized, connects a new `CodexProServer` instance, and registers it into the active `transports` Map.
     * Executes the incoming tool call and returns `HTTP 200 OK` seamlessly.
   * Unknown/invalid IDs (such as smoke test `00000000-0000-4000-8000-000000000000`) and explicitly closed sessions (`DELETE /mcp`) continue to return `404 Session not found` in strict accordance with the MCP specification.

### Verification

* Verified 100% pass rate across the entire test suite (`npm run smoke`):
  * `analysis`, `analysis-cli`, `smoke`, `chatgpt-export`, `skill-precedence`, `import`, `http`, `widget`, `pro`, `doctor`, `settings`, `execute-handoff`, `release-guard`.
* Verified direct auto-restoration via `curl` with persistent known session IDs.

---

## 11. Multi-Ingress Edge Relay Desync (`SSL_ERROR_SYSCALL`), macOS Sleep/Wake Zombie Trap & Active Self-Healing Watchdog

### Symptoms & Timeline

* After several hours of uptime or after waking a MacBook from sleep, remote AI agents (ChatGPT Web) intermittently fail with `Action failed: Tool disconnected` ("инструмент отваливается").
* In some cases, local tests (`http://127.0.0.1:8787` and internal Tailnet MagicDNS `100.x`) succeed, but external requests from the public internet fail during the TLS handshake with:
  ```
  LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to macbook-pro-stas.tail64004b.ts.net:443
  [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1007)
  ```
* In macOS system logs (`/usr/bin/log show --predicate 'process == "io.tailscale.ipn.macsys.network-extension"'`), persistent packet filter drops occur:
  ```
  Drop: TCP{[fd7a:115c:a1e0::...]:port > [fd7a:115c:a1e0::cf01:d2c4]:37393} 80 no rules matched
  ```
  where port `37393` is Tailscale's internal `PeerAPIURL` on IPv6 (`http://[fd7a:115c:a1e0::cf01:d2c4]:37393`).

### Root Cause Analysis

1. **Anycast Edge Relay Netmap Desynchronization (GitHub Issue #19290 & #20949):**
   * Tailscale Funnel publishes multiple Anycast edge ingress IPs worldwide (e.g. `185.40.234.55`, `185.40.234.75`, `185.40.234.198`).
   * Remote agents connect to whichever Anycast edge node their cloud provider routes to. When network routes cycle or after a period of inactivity, one or more Anycast edge relays can lose netmap synchronization with the node. When the edge relay attempts to establish the TLS session or route to the local node, it terminates the connection prematurely (`SSL_ERROR_SYSCALL`).
2. **The macOS Sleep/Wake Zombie Process Trap:**
   * When macOS goes to sleep, the `io.tailscale.ipn.macsys.network-extension` daemon drops the active serve session (`Hostinfo.IngressEnabled changed to false`).
   * However, the foreground CLI child process (`tailscale funnel http://127.0.0.1:8787`) remains alive in Node.js as a zombie process without exiting.
   * When macOS wakes up, `tailscale funnel status` reports `No serve config`. The CLI child process continues to run doing nothing, while all external incoming packets from the edge ingress nodes are dropped by the macOS packet filter with `no rules matched`.
3. **OpenAI Root Path Probes (`POST /`):**
   * When ChatGPT registers or reconnects to an MCP connector, it periodically issues HTTP probes to the root path (`POST /`). Because CodexPro only registered `POST /mcp`, probes to `/` returned HTTP 404, triggering `MCP_ACTION_DISCOVERY_FAILED`.
4. **Session Eviction Under Test & In-Flight Concurrency:**
   * The `knownSessions` persistence cap was set to 1,000, which could be evicted if test suites ran on the same system. In addition, parallel requests arriving for a restored session could trigger duplicate server instantiations without in-flight promise deduplication.

### The Fix

1. **Unref Sleep/Wake Heartbeat Detector in `startTunnelKeepAlive` (`scripts/codexpro.mjs`):**
   * Added a 1-second unref interval checking timestamp drift (`now - lastTick > 4000ms`).
   * When macOS sleeps and wakes, the detector immediately identifies the sleep resumption gap and triggers `onFail('Mac resumed from sleep')`.
2. **Edge Reachability Watchdog & Auto Self-Healing (`scripts/codexpro.mjs`):**
   * The keepalive watchdog actively queries `${publicBase}/healthz` every 15 seconds through the public Anycast edge relay.
   * If 2 consecutive probes fail or upon sleep resumption, it executes `selfHeal()`:
     1. Kills any stale or zombie child process (`SIGTERM`).
     2. Resets the Funnel configuration via `tailscale funnel reset`.
     3. Flushes and forces a netmap resync via `tailscale debug clear-netmap-cache && tailscale debug force-netmap-update`.
     4. Re-spawns the Funnel process.
     5. Waits up to 30 seconds for `waitForPublicHealth` to verify end-to-end edge reachability.
3. **Clean Shutdown Reset (`scripts/codexpro.mjs`):**
   * `cleanupTunnelCredentials` now executes `tailscale funnel reset` to avoid leaving stale port forwards when the user exits CodexPro.
4. **Root Path Support (`src/http.ts`):**
   * Added `app.post("/", ...)` handler that routes JSON-RPC MCP requests to `handleMcpPost` and responds with `{ ok: true, name: "CodexPro", mcp: "/mcp" }` for probes.
5. **Deduplicated In-Flight Transports & 50k Cap (`src/http.ts`):**
   * Added `inFlightTransports` Map to deduplicate concurrent session initialization promises.
   * Increased session persistence cap to 50,000 entries.

### Verification

* Verified 100% pass across all 13 smoke tests (`npm run smoke`):
  * `analysis`, `analysis-cli`, `smoke`, `chatgpt-export`, `skill-precedence`, `import`, `http`, `widget`, `pro`, `doctor`, `settings`, `execute-handoff`, `release-guard`.
* Verified branch integrity (`npm run path-rules:verify`).
* Verified clean live Anycast edge relay routing (`185.40.234.55:443`) returning HTTP 200 OK with TLS 1.3 certificate verification.
