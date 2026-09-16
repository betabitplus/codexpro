# CodexPro Workspace Continuity & Session Stability Across Turns

**Date:** 2026-09-16  
**Status:** Production Ready  
**Branch:** `path-rules`  
**Affected Components:** `src/guard.ts`, `src/http.ts`, `src/server.ts`, `src/toolCardWidget.ts`  
**Test Suite:** `scripts/workspace-continuity-smoke.mjs` (incorporated into `npm run smoke`)

---

## 1. Context & User Symptoms

When working with ChatGPT (via remote agent connectors, Tailscale Funnel, or reverse proxies), agents frequently reported:
1. *"Связь с локальным CodexPro сейчас кратковременно флапает (UNAVAILABLE)"*
2. *"Мост потерял workspace session и несколько раз отвечает UNAVAILABLE"*
3. *"Локальный Codex MCP сейчас нестабилен — workspace открывает, а следующий terminal call рвёт соединение UNAVAILABLE"*

Despite the user seeing the local daemon process alive and Tailscale healthy, the agent failed to execute consecutive commands in the opened project.

---

## 2. Root Cause Analysis (Manual Reproduction & Verification)

Manual end-to-end tests against the live HTTP bridge revealed three distinct flaws:

### Bug 1: Ephemeral MCP Sessions Across ChatGPT Turns
* **Mechanism:** ChatGPT Web infrastructure connects from ephemeral serverless containers. On almost every user turn or prompt, OpenAI initiates a new HTTP connection and issues an `initialize` call with a new session UUID.
* **Failure:** In CodexPro, `WorkspaceManager` was instantiated per-session inside `createCodexProServer`. When Turn 1 opened a project (`open_workspace: /Users/stas/.../gptty`), the selection was saved only in Session 1. When Turn 2 arrived with Session 2 and ran `bash: { command: "git status" }` (without an explicit `workspace_id`), Session 2 defaulted to the server launch root (`defaultRoot`, e.g. `Playground`).
* **Consequence:** Git commands failed with `fatal: not a git repository`, files were missing, and the agent concluded the workspace bridge was broken or dropped.

### Bug 2: Workspaces Not Persisted to Disk (Loss on Restart)
* **Mechanism:** `open_workspace` stored workspaces in an in-memory `sharedWorkspaces` map. It never wrote runtime profiles to disk.
* **Failure:** If the CodexPro process restarted, was reloaded, or experienced worker respawn, `sharedWorkspaces` was cleared.
* **Consequence:** When ChatGPT subsequently called tools with the remembered `workspace_id` (e.g. `ws_cbb75199db3f59e418d05045`), `getWorkspace(id)` threw:
  ```text
  CodexProError: Unknown workspace_id: ws_cbb75199db3f59e418d05045. Call open_workspace first.
  ```

### Bug 3: Aggressive 1.2s Widget Fallback ("Result unavailable")
* **Mechanism:** In `src/toolCardWidget.ts`, line 527 configured:
  ```javascript
  fallbackTimer = window.setTimeout(renderUnavailable, 1200);
  ```
* **Failure:** 1200ms was far too short for bash executions, test suites, or Tailscale roundtrip latency.
* **Consequence:** Even while a command was executing normally, the ChatGPT UI widget displayed:
  > **Result unavailable**  
  > The tool finished, but its display data did not reach this card. Refresh the ChatGPT plugin connection and try the action once more.
  
  This false warning led agents to believe the connection dropped and report "UNAVAILABLE".

---

## 3. Architecture & Implementation

### A. Workspace Runtime Disk Persistence (`src/guard.ts`)
* **Runtime Workspaces:** Any workspace opened via `openWorkspace` is persisted to `~/.codexpro/runtime/${hash}.json` (mode `0o600`).
* **Active Workspace Tracking:** In non-isolated mode, selecting a workspace writes `~/.codexpro/runtime/active_workspace.json`.
* **On-Demand Revival:** When `getWorkspace(id)` is called after a server restart, it checks `runtimeDir()` for `${hash}.json`. If the root exists and is within `allowedRoots`, it revives the workspace seamlessly.

### B. Session Continuity for ChatGPT & Single-User Workflows (`src/guard.ts`, `src/http.ts`)
* **Session Client Identification:** `src/http.ts` tracks `clientName` from the MCP `initialize` request (`req.body.params.clientInfo.name`).
* **Continuity by Default:** For ChatGPT (`openai-mcp`) and stateless sessions (`00000000-0000-4000-a000-000000000001`), `WorkspaceManager` initializes `selectedWorkspaceId` from `sharedSelectedWorkspaceId` or `active_workspace.json`.
* **Subsequent Calls:** When ChatGPT runs `bash`, `read`, `edit`, or other tools without passing `workspace_id`, the call executes in the active project workspace rather than falling back to `defaultRoot`.

### C. Strict Isolation for Multi-Tenant & Synthetic Tests (`src/http.ts`, `src/guard.ts`)
* Synthetic test clients (e.g. `codexpro-http-smoke`) or sessions with `CODEXPRO_ISOLATE_SESSIONS=1` run in `isolated: true` mode.
* In isolated mode, `WorkspaceManager` does NOT inherit `sharedSelectedWorkspaceId`, does not overwrite `active_workspace.json`, and only lists workspaces opened in that session, guaranteeing 100% test compatibility with `scripts/http-smoke.mjs`.

### D. Widget Fallback Timer Safety (`src/toolCardWidget.ts`)
* Increased `fallbackTimer` from **1200ms** to **45,000ms (45s)**.
* The card remains in `renderPending()` ("Loading the tool result...") while commands execute. Once output arrives, `render()` clears the timer and displays the output cleanly.

---

## 4. Verification & Testing

### Automated Regression Testing
All 14 smoke test suites pass without regression:
```bash
npm run smoke
```
1. `analysis-smoke.mjs`
2. `analysis-cli-smoke.mjs`
3. `smoke.mjs`
4. `chatgpt-export-smoke.mjs`
5. `skill-precedence-smoke.mjs`
6. `import-smoke.mjs`
7. `http-smoke.mjs`
8. `widget-smoke.mjs`
9. `pro-smoke.mjs`
10. `doctor-smoke.mjs`
11. `settings-smoke.mjs`
12. `execute-handoff-smoke.mjs`
13. `workspace-continuity-smoke.mjs` (New comprehensive E2E test)
14. `release-guard-smoke.mjs`

### E2E Continuity Test Flow (`scripts/workspace-continuity-smoke.mjs`)
* **Turn 1:** `openai-mcp` Client 1 calls `open_workspace` on a separate project directory -> workspace opened.
* **Turn 2:** `openai-mcp` Client 2 (new connection, fresh session ID) calls `bash pwd` without `workspace_id` -> returns project directory!
* **Turn 3:** Server process is killed (`kill`) and restarted fresh on the same port.
* **Turn 4:** `openai-mcp` Client 3 on the new server calls `bash pwd` without `workspace_id` -> still returns project directory via revived runtime state!
* **Turn 5:** Isolated test client (`codexpro-http-smoke`) connects and calls `list_workspaces` -> retains default root and does not leak the other workspace.

---

## 5. Maintenance & Rollback Guide

### How to Force Strict Isolation (Disable Continuity)
If you ever want every session to be strictly isolated without cross-turn continuity:
```bash
export CODEXPRO_ISOLATE_SESSIONS=1
```
Or pass it when launching:
```bash
CODEXPRO_ISOLATE_SESSIONS=1 codexpro start ...
```

### How to Clear Saved Runtime Workspaces
To clear the active workspace and cached runtime profiles:
```bash
rm -f ~/.codexpro/runtime/active_workspace.json
rm -f ~/.codexpro/runtime/*.json
```

### How to Roll Back Code Changes
To revert the workspace continuity commit:
```bash
git revert HEAD
npm run build
npm run smoke
```
