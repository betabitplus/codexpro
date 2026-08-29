# CodexPro Path Rules Fork

This repository is a thin fork of upstream CodexPro with one additional feature: path-scoped instructions loaded from the same rule files used by `codex-path-rules`.

Upstream base at fork creation: `rebel0789/codexpro` `0.30.0`, commit `587f7fd3a4644a847bba13aeb49336056052e1f6`.
Path-rules layer version: `0.2.0`.

## What the patch does

The integration is intentionally narrow:

- upstream `registerCodexTool()` remains the single registration seam;
- one pre-tool gate runs after CodexPro validates tool arguments but before the real handler executes;
- `WorkspaceManager` maintains a process-level shared workspace registry so workspaces opened in one MCP instance can be resolved by `workspace_id` in another instance while validating `allowedRoots` and keeping `selectedWorkspaceId` instance-local;
- all path-rule parsing/matching and proof validation lives in `src/pathRules.ts`; the gate does not use elapsed time, tool-call counts, MCP session caches, or compaction guesses to decide whether a rule is present;
- path-aware tool schemas expose optional `path_rules_proof`, a map from rule fingerprint to the full canonical rule text previously returned by the gate;
- `server_config` exposes `pathRules` status including proof mode so a live install can be identified;
- the stored handler used by the `codexpro` supertool is the same gated handler, so child actions cannot bypass path rules and may carry the same proof inside `args`.

No Codex hook API is involved. The rule is delivered to ChatGPT through the blocked MCP tool result inside the current tool loop.

## Rule files

Repo-local rules:

```text
<repo>/.codex/path-rules/*.md
```

Global rules:

```text
~/.codex/path-rules/*.md
```

Format:

```md
---
paths:
  - "tests/**"
  - "**/*.py"
exclude:
  - "tests/fixtures/**"
---

Do not weaken tests to make them green.
Fix production code first.
Run the relevant tests after changes.
```

The format intentionally matches the existing `codex-path-rules` repository.

## Runtime semantics

For a tool call whose path matches a rule:

1. CodexPro resolves the active workspace and repo root (supporting process-level `workspace_id` resolution across MCP sessions).
2. The gate compares the current call's `path_rules_proof` against every matching rule.
3. A proof entry is valid only when its key is the current rule fingerprint and its value is the full canonical rule text that CodexPro would show to the model after redaction.
4. If every matching rule has an exact proof, the real tool handler executes immediately. This is true across different tools, actions, MCP sessions, reconnects, and arbitrary elapsed time.
5. If any matching proof is absent, stale, summarized, abbreviated, or otherwise different, the call is blocked before execution. The result returns the missing rule text plus the exact `path_rules_proof` payload required for a retry.
6. ChatGPT re-evaluates the action. If it still wants the action, it retries while attaching that exact proof. Later calls touching the same rule should keep attaching the same full proof text.
7. If internal context compaction drops the rule/proof text, the model can no longer reproduce the exact proof; the next matching call is blocked and the rule is injected again. There is no compaction timer or tool-count heuristic.
8. If the rule file content changes, its fingerprint changes and any old proof becomes invalid automatically.

The proof itself contains the rule text rather than an opaque nonce. An opaque token could survive compaction after the rule meaning was lost; exact-text proof is intended to make retained proof equivalent to retained rule content.

Path extraction is exact for the normal file tools and `apply_patch`. Bash extraction is best-effort, like the original Codex hook implementation.

Currently covered tools:

- `tree`
- `search`
- `read`
- `view_image`
- `write`
- `edit`
- `import_file`
- `git_status`
- `git_diff`
- `show_changes`
- `inspect_workspace`
- `codex_context`
- `apply_patch`
- `bash` (best-effort shell path extraction)
- the same child tools when invoked through `codexpro`

Set `CODEXPRO_PATH_RULES=0` to disable this layer without removing the fork.

## Important limitation

CodexPro still does not receive a Codex-style `PostCompact` event from ChatGPT, so it cannot observe compaction directly. Exact-text proof avoids needing that event: the gate asks the current tool call to demonstrate that the applicable rule text is still reproducible from model context. This is stronger than a timer/counter heuristic, but it intentionally adds the rule text to matching tool-call arguments and therefore has a token-cost proportional to the retained rules.

HTTP connectors such as ChatGPT may create distinct MCP sessions or reconnect between successive tool calls. Proof validation is independent of MCP session identity. Clients should still explicitly pass the `workspace_id` returned from `open_workspace` in subsequent calls, and the server resolves these via the process-level workspace registry.

This is a steering/context guard, not a filesystem ACL. Hard prohibitions still belong in CodexPro safety policy, CI, repository permissions, or another enforcement layer.

## Verification

Fast integration-shape check:

```bash
npm run path-rules:compat
```

Real MCP behavior test:

```bash
npm run path-rules:smoke
```

Full fork verification, including the complete upstream CodexPro smoke suite:

```bash
npm run path-rules:verify
```

`path-rules:smoke` verifies, among other things:

- matching calls without proof are blocked and receive the rule plus structured `path_rules_required_proof`;
- exact full-text proof allows the retry and later different actions touching the same rule without another block;
- wrong/abbreviated proof is rejected;
- omitting proof again in the same MCP session simulates lost context and re-injects the rule;
- excluded paths are not blocked;
- matching writes and `apply_patch` calls do not modify files before valid proof is supplied;
- Bash path detection blocks the command before execution;
- global rules work;
- the `codexpro` supertool cannot bypass the gate and accepts proof inside child `args`;
- changing a rule body invalidates old proof and returns a new proof;
- cross-MCP-session `workspace_id` reuse resolves accurately;
- the same exact proof works across separate MCP client sessions.

## Installing this local fork

From this repository:

```bash
npm ci
npm run path-rules:verify
npm link
```

`npm link` keeps the global `codexpro` command pointed at this working tree, so future fork updates only require rebuilding/testing and restarting CodexPro.

Do not run `npm install -g codexpro@latest` while using this fork: a global install can replace the `npm link` and silently switch the `codexpro` command back to the upstream package without path rules. Update the fork from `upstream`, verify it, then run `npm link` again instead.

Use the stable HTTP token file and disable CodexPro's built-in tunnel when an external Tailscale Funnel already proxies the local port. On this Mac the live command is:

```bash
codexpro start \
  --root /Users/stas/Documents/3.Projects/1.Playground \
  --allow-home \
  --token-file ~/.codexpro/http-token \
  --tunnel none
```

The explicit `--tunnel none` is important here: plain `codexpro start` also attempts a Cloudflare quick tunnel, and a Cloudflare startup failure can terminate the otherwise healthy local MCP server. The existing Tailscale Funnel already proxies `https://macbook-pro-stas.tail64004b.ts.net/` to `http://127.0.0.1:8787`, so a second tunnel is unnecessary.

After a live restart, `server_config` should contain a `pathRules` object with `enabled: true`, `layerVersion: "0.2.0"`, and `proofMode: "exact-rule-text"`.

## Updating from upstream

This repo should track the official project as remote `upstream`, with local changes on branch `path-rules`.

Normal update flow:

```bash
git fetch upstream
git rebase upstream/main
npm ci
npm run path-rules:verify
npm link
```

If the rebase conflicts, stop and review the upstream changes instead of forcing the patch through.

Even if the rebase is clean, `npm run path-rules:compat` intentionally fails if the central registration seam, the `WorkspaceManager` API, or another required integration assumption has changed. Treat that failure as an explicit request to re-audit the patch before installing/restarting it.

Only after `path-rules:verify` passes should `npm link` be refreshed and the live CodexPro process be restarted.
