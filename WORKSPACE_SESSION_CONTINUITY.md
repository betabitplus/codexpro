# CodexPro Workspace Continuity, Concurrency & Session Stability Across Turns

**Date:** 2026-09-16  
**Status:** Production Ready  
**Branch:** `path-rules`  
**Affected Components:** `src/guard.ts`, `src/http.ts`, `src/server.ts`, `src/toolCardWidget.ts`  
**Test Suite:** `scripts/workspace-continuity-smoke.mjs`, `scripts/concurrent-stress-test.mjs`, `scripts/aggressive-stress-test.mjs`

---

## 1. Context & User Symptoms

When working with ChatGPT (via remote agent connectors, Tailscale Funnel, or reverse proxies), agents frequently reported:
1. *"Связь с локальным CodexPro сейчас кратковременно флапает (UNAVAILABLE)"*
2. *"Мост потерял workspace session и несколько раз отвечает UNAVAILABLE"*
3. *"Локальный Codex MCP сейчас нестабилен — workspace открывает, а следующий terminal call рвёт соединение UNAVAILABLE"*
4. *"Codex bridge снова отвалился с UNAVAILABLE до получения результата... Codex MCP сейчас реально недоступен (Connection failed даже на open_workspace)"*

Despite the local daemon process being alive and Tailscale active, long-running commands (like `resume_send_latency_single.py` running for ~28s) or overlapping actions caused requests to hang, time out, and flap connections.

---

## 2. Root Cause Analysis (Evidence from Logs & Reproduction)

Detailed log investigation of `codexpro.log` revealed the underlying chain of failures:

### Bug 1: Stateless Transport Collision on Shared Message ID (The 28s Test Hang Bug)
* **Mechanism:**
  - ChatGPT web client issues stateless HTTP POST requests without `Mcp-Session-Id` (`session=-`).
  - Almost every stateless request from ChatGPT sends JSON-RPC with `id: 0`.
  - In commit `0aa74f6`, a static session ID (`00000000-0000-4000-a000-000000000001`) was assigned to all stateless requests so they could share transport and avoid 400 errors.
* **Failure:**
  - In `@modelcontextprotocol/sdk` (`WebStandardStreamableHTTPServerTransport`), active requests are tracked in an internal map:
    ```typescript
    this._requestToStreamMapping.set(message.id, streamId);
    ```
  - When a long-running command (e.g. `resume_send_latency_single.py` taking ~28 seconds) was in flight with `id: 0`, any second request (background check, another tab, or second tool call) also arrived with `id: 0`.
  - The second request **overwrote** `id: 0` in the transport map!
  - As a result, when the long-running command finished, the transport could no longer find the original HTTP stream. The HTTP response promise was orphaned.
  - The request hung in the HTTP server until the Node.js socket timeout (300,000ms / 5 minutes), at which point `[client disconnected]` was logged.
  - ChatGPT gave up after ~30s with `UNAVAILABLE до получения результата`.
  - When the 5-minute socket reset finally triggered, the sudden socket termination disrupted connection pooling across Tailscale Funnel / reverse proxies, causing subsequent requests to fail immediately (`Connection failed даже на open_workspace`).

### Bug 2: Ephemeral MCP Sessions Across ChatGPT Turns
* **Mechanism:** ChatGPT Web infrastructure connects from ephemeral serverless containers. On almost every user turn or prompt, OpenAI initiates a new HTTP connection and issues an `initialize` call with a new session UUID.
* **Failure:** In CodexPro, `WorkspaceManager` was instantiated per-session inside `createCodexProServer`. When Turn 1 opened a project (`open_workspace: /Users/stas/.../gptty`), the selection was saved only in Session 1. When Turn 2 arrived with Session 2 and ran `bash: { command: "git status" }` (without an explicit `workspace_id`), Session 2 defaulted to the server launch root (`defaultRoot`, e.g. `Playground`).
* **Consequence:** Git commands failed with `fatal: not a git repository`, files were missing, and the agent concluded the workspace bridge was broken or dropped.

### Bug 3: Workspaces Not Persisted to Disk (Loss on Restart)
* **Mechanism:** `open_workspace` stored workspaces in an in-memory `sharedWorkspaces` map. It never wrote runtime profiles to disk.
* **Failure:** If the CodexPro process restarted, was reloaded, or experienced worker respawn, `sharedWorkspaces` was cleared.
* **Consequence:** When ChatGPT subsequently called tools with the remembered `workspace_id` (e.g. `ws_cbb75199db3f59e418d05045`), `getWorkspace(id)` threw `Unknown workspace_id`.

### Bug 4: Aggressive 1.2s Widget Fallback ("Result unavailable")
* **Mechanism:** In `src/toolCardWidget.ts`, line 527 configured:
  ```javascript
  fallbackTimer = window.setTimeout(renderUnavailable, 1200);
  ```
* **Failure:** 1200ms was far too short for bash executions, test suites, or Tailscale roundtrip latency.
* **Consequence:** Even while a command was executing normally, the ChatGPT UI widget displayed a false warning that the tool result did not reach the card.

---

## 3. Architecture & Fixes

### A. Dedicated Request-Scoped Transports for Stateless Requests (`src/http.ts`)
* In stateless mode (no `Mcp-Session-Id`), every HTTP POST is assigned a unique, dedicated transport via `randomUUID()`.
* In a `finally` block, the transport is cleaned up immediately upon request completion:
  ```typescript
  const isStateless = !sessionId && !isInitializeRequest(req.body);
  if (isStateless) {
    sessionId = randomUUID();
  }
  // ...
  try {
    await transport.handleRequest(req, res, req.body);
  } finally {
    if (isStateless && sessionId) {
      transports.delete(sessionId);
      closedSessions.add(sessionId);
    }
  }
  ```
* **Why this is completely safe for continuity:**
  Workspace selection continuity does **not** rely on in-memory transport sharing. Workspace selection is tracked cleanly in `WorkspaceManager` via `sharedSelectedWorkspaceId` in RAM and persisted on disk to `~/.codexpro/runtime/active_workspace.json`.
  Each request now has an isolated JSON-RPC message stream (no message ID collisions, no overwritten response promises), while executing seamlessly in the active workspace.

### B. Workspace Runtime Disk Persistence (`src/guard.ts`)
* **Runtime Workspaces:** Any workspace opened via `openWorkspace` is persisted to `~/.codexpro/runtime/${hash}.json` (mode `0o600`).
* **Active Workspace Tracking:** In non-isolated mode, selecting a workspace writes `~/.codexpro/runtime/active_workspace.json`.
* **On-Demand Revival:** When `getWorkspace(id)` is called after a server restart, it checks `runtimeDir()` for `${hash}.json`. If the root exists and is within `allowedRoots`, it revives the workspace seamlessly.

### C. Session Continuity for ChatGPT & Single-User Workflows (`src/guard.ts`, `src/http.ts`)
* Tracks `clientName` from the MCP `initialize` request (`req.body.params.clientInfo.name`).
* For ChatGPT (`openai-mcp`) and stateless sessions, `WorkspaceManager` initializes `selectedWorkspaceId` from `sharedSelectedWorkspaceId` or `active_workspace.json`.
* Subsequent tool calls without `workspace_id` execute directly in the active project workspace.

### D. Strict Isolation for Multi-Tenant & Synthetic Tests (`src/http.ts`, `src/guard.ts`)
* Synthetic test clients (e.g. `codexpro-http-smoke`) or sessions with `CODEXPRO_ISOLATE_SESSIONS=1` run in `isolated: true` mode without inheriting or leaking active workspace state.

### E. Widget Fallback Timer Safety (`src/toolCardWidget.ts`)
* Increased `fallbackTimer` from **1200ms** to **45,000ms (45s)**.

---

## 4. Verification & Stress Test Suite

### A. Full Smoke Suite (14 Tests)
All 14 smoke test suites pass with zero regressions:
```bash
npm run smoke
```

### B. Concurrency & Collision Stress Test (`npm run stress:concurrent`)
Runs a slow bash command (2.6s) while simultaneously dispatching 3 fast bash commands with identical JSON-RPC `id: 0`.
- Verifies that fast requests complete in ~500ms without being blocked or orphaned by the slow command.
- Verifies that the slow command returns 200 OK cleanly.

### C. Ultra-Aggressive Multi-Client Resilience Test (`npm run stress:aggressive`)
Simulates extreme, worst-case real-world conditions with safety margin:
1. **Phase 1 (Workspace Selection):** Opens `/Users/stas/.../gptty` via stateless MCP tool call.
2. **Phase 2 (20-Client Massive Wave):** Fires 20 overlapping requests simultaneously:
   - 4 slow bash commands (1.5s - 3s)
   - 6 fast bash `pwd` commands (each strictly asserting that workspace continuity in `/gptty` holds!)
   - 4 file read commands
   - 3 full stateful MCP SDK clients connecting and initializing concurrently
   - 3 git_status commands
   - **Result:** All 20 requests returned 200 OK with zero hangs and 100% workspace continuity!
3. **Phase 3 (Client Abort Simulation):**
   - Fires a 4-second command and aborts the HTTP socket at 150ms (simulating the user clicking "Stop generating" in ChatGPT).
   - Immediately fires a follow-up request on the same port to verify the server did not deadlock, leak sockets, or become unresponsive.
   - **Result:** Follow-up request succeeded in ~600ms.

---

## 5. Live Traffic & Hang Monitor

A dedicated real-time monitoring script is included at `scripts/monitor.mjs`:
```bash
npm run monitor
```
* Monitors `~/.codexpro/log/codexpro.log` continuously.
* Displays in-flight requests, durations, completions, disconnects, and any request exceeding 30s.
* Writes live machine-readable status to `~/.codexpro/monitor-status.json`.
* Check current health at any time:
  ```bash
  cat ~/.codexpro/monitor-status.json
  ```

---

## 6. Maintenance & Rollback Guide

### How to Run Verification Tests
```bash
npm run smoke                 # Standard smoke suite (14 suites)
npm run stress:concurrent     # Test for JSON-RPC ID collision
npm run stress:aggressive     # 20-client high-concurrency stress test
```

### How to Force Strict Isolation
```bash
export CODEXPRO_ISOLATE_SESSIONS=1
```

### How to Clear Saved Runtime Workspaces
```bash
rm -f ~/.codexpro/runtime/active_workspace.json
rm -f ~/.codexpro/runtime/*.json
```

### How to Roll Back Changes
To revert:
```bash
git revert HEAD
npm run build
npm run smoke
```
