import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { exportChatGPTChats } from "./chatgptExportOps.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LocalEvent {
  event_id?: string;
  turn_id?: string;
  observed_at?: string;
  role?: string;
  text?: string;
  model?: string | null;
  status?: string;
  conversation_id?: string | null;
}

interface WebMessage {
  id?: string;
  parent_id?: string | null;
  role?: string;
  text?: string;
  created_at?: string | null;
  model?: string | null;
  current_branch?: boolean;
  branch_index?: number;
  branch_total?: number;
}

interface WebContext {
  schema?: number;
  conversation_id?: string;
  source_url?: string;
  title?: string;
  scope?: string;
  current_node_id?: string | null;
  messages?: WebMessage[];
  branch_points?: number;
  leaf_branches?: number;
}

interface MatchRecord {
  local_event_id: string | null;
  local_turn_id: string | null;
  web_node_id: string | null;
  role: string;
  matched_by: "role+text";
  ambiguous_candidates: number;
}

export interface ResolvedChatGPTContextItem {
  ok: boolean;
  conversation_id: string;
  source_url: string;
  status: string;
  local_events_path: string | null;
  local_transcript_path: string | null;
  web_markdown_path: string | null;
  web_context_path: string | null;
  resolved_context_path: string | null;
  reconcile_state_path: string | null;
  counts: {
    local_events: number;
    web_messages: number;
    matched: number;
    local_only: number;
    web_only: number;
    ambiguous: number;
    branch_points: number;
  };
  error?: string;
}

export interface ResolveChatGPTContextResult {
  ok: boolean;
  count: number;
  resolved: number;
  failed: number;
  results: ResolvedChatGPTContextItem[];
}

export interface ReadResolvedChatGPTContextResult {
  conversation_id: string;
  source_url: string;
  path: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  next_start_line: number | null;
  text: string;
}

function conversationId(value: string): string {
  const raw = value.trim();
  if (UUID_RE.test(raw)) return raw.toLowerCase();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Expected a private https://chatgpt.com/c/<id> URL or conversation UUID.");
  }
  if (!["chatgpt.com", "www.chatgpt.com"].includes(url.hostname)) {
    throw new Error("Expected a private https://chatgpt.com/c/<id> URL or conversation UUID.");
  }
  const match = url.pathname.match(/\/c\/([0-9a-f-]{36})(?:\/|$)/i);
  if (!match || !UUID_RE.test(match[1])) {
    throw new Error("Only private ChatGPT conversation links in the form https://chatgpt.com/c/<id> are supported.");
  }
  return match[1].toLowerCase();
}

function defaultArchiveRoot(): string {
  const explicit = process.env.GPTTY_ARCHIVE_HOME?.trim();
  if (explicit) return path.resolve(expandHome(explicit));
  const dataHome = process.env.GPTTY_DATA_HOME?.trim();
  if (dataHome) return path.resolve(expandHome(dataHome), "chat-archive");
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return path.resolve(expandHome(xdg), "gptty", "chat-archive");
  return path.join(os.homedir(), ".local", "share", "gptty", "chat-archive");
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function readJsonLines(filePath: string): Promise<LocalEvent[]> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const result: LocalEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        result.push(value as LocalEvent);
      }
    } catch {
      // Append-only journals tolerate a single corrupt/truncated line.
    }
  }
  return result;
}

async function readWebContext(filePath: string | null): Promise<WebContext | null> {
  if (!filePath) return null;
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as WebContext;
  } catch {
    return null;
  }
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedRole(value: unknown): string {
  const role = String(value ?? "").trim().toLowerCase();
  return role === "assistant" ? "assistant" : role === "user" ? "user" : role;
}

function messageKey(role: unknown, text: unknown): string {
  return `${normalizedRole(role)}\u0000${normalizeText(text)}`;
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
  );
}

function safeWebMessages(context: WebContext | null): WebMessage[] {
  return Array.isArray(context?.messages)
    ? context!.messages.filter((item): item is WebMessage => Boolean(item) && typeof item === "object")
    : [];
}

function reconcile(localEvents: LocalEvent[], webContext: WebContext | null): {
  matches: MatchRecord[];
  matchedWebIndexes: Set<number>;
  localOnlyIndexes: number[];
  ambiguous: number;
} {
  const webMessages = safeWebMessages(webContext);
  const buckets = new Map<string, number[]>();
  webMessages.forEach((message, index) => {
    const key = messageKey(message.role, message.text);
    const list = buckets.get(key) ?? [];
    list.push(index);
    buckets.set(key, list);
  });

  const usedWeb = new Set<number>();
  const matches: MatchRecord[] = [];
  const localOnlyIndexes: number[] = [];
  let ambiguous = 0;

  localEvents.forEach((event, localIndex) => {
    const candidates = (buckets.get(messageKey(event.role, event.text)) ?? []).filter(
      (index) => !usedWeb.has(index)
    );
    if (!candidates.length) {
      localOnlyIndexes.push(localIndex);
      return;
    }
    const ordered = [...candidates].sort((a, b) => {
      const currentA = webMessages[a]?.current_branch === true ? 0 : 1;
      const currentB = webMessages[b]?.current_branch === true ? 0 : 1;
      return currentA - currentB || a - b;
    });
    const chosen = ordered[0];
    usedWeb.add(chosen);
    if (candidates.length > 1) ambiguous += 1;
    matches.push({
      local_event_id: event.event_id ? String(event.event_id) : null,
      local_turn_id: event.turn_id ? String(event.turn_id) : null,
      web_node_id: webMessages[chosen]?.id ? String(webMessages[chosen]?.id) : null,
      role: normalizedRole(event.role),
      matched_by: "role+text",
      ambiguous_candidates: candidates.length
    });
  });

  return {
    matches,
    matchedWebIndexes: usedWeb,
    localOnlyIndexes,
    ambiguous
  };
}

function reconciliationStatus(options: {
  localCount: number;
  webCount: number;
  localOnly: number;
  webOnly: number;
  webAvailable: boolean;
}): string {
  if (!options.webAvailable) return options.localCount ? "local-only-web-unavailable" : "unavailable";
  if (!options.localCount) return options.webCount ? "web-only" : "empty";
  if (!options.localOnly && !options.webOnly) return "aligned";
  if (options.localOnly && !options.webOnly) return "local-ahead";
  if (!options.localOnly && options.webOnly) return "web-ahead";
  return "diverged";
}

function renderResolvedMarkdown(options: {
  conversationId: string;
  sourceUrl: string;
  localEvents: LocalEvent[];
  webContext: WebContext | null;
  webMarkdownPath: string | null;
  webContextPath: string | null;
  localEventsPath: string | null;
  localTranscriptPath: string | null;
  status: string;
  matchedWebIndexes: Set<number>;
  localOnlyIndexes: number[];
  ambiguous: number;
}): string {
  const webMessages = safeWebMessages(options.webContext);
  const webOnly = webMessages.length - options.matchedWebIndexes.size;
  const lines = [
    `# Reconciled ChatGPT context`,
    "",
    `- Conversation ID: \`${options.conversationId}\``,
    `- Web: ${options.sourceUrl}`,
    `- Reconciliation: \`${options.status}\``,
    `- TUI events: ${options.localEvents.length}`,
    `- Web-visible messages: ${webMessages.length}`,
    `- Matched observations: ${options.matchedWebIndexes.size}`,
    `- TUI-only retained: ${options.localOnlyIndexes.length}`,
    `- Web-only retained: ${webOnly}`,
    `- Ambiguous text matches: ${options.ambiguous}`,
    `- Branch points: ${Number(options.webContext?.branch_points ?? 0)}`,
    "- Safety: a message missing from the current web snapshot is never treated as deleted; TUI-only observations remain authoritative evidence that gptty saw them.",
    "",
    "## Sources",
    "",
    `- Local TUI ledger: ${options.localEventsPath ?? "not available"}`,
    `- Local TUI Markdown: ${options.localTranscriptPath ?? "not available"}`,
    `- Canonical web Markdown: ${options.webMarkdownPath ?? "not available"}`,
    `- Canonical web graph sidecar: ${options.webContextPath ?? "not available"}`,
    ""
  ];

  if (webMessages.length) {
    lines.push("## Canonical web graph with provenance", "");
    webMessages.forEach((message, index) => {
      const provenance = options.matchedWebIndexes.has(index) ? "both" : "web-only";
      const current = message.current_branch === true ? " · current branch" : "";
      lines.push(
        `### WEB ${index + 1} — ${normalizedRole(message.role).toUpperCase()} — ${provenance}${current}`,
        "",
        `- Node ID: \`${String(message.id ?? "unknown")}\``,
        `- Parent ID: ${message.parent_id ? `\`${message.parent_id}\`` : "root"}`,
        `- Branch choice: ${Number(message.branch_index ?? 1)} of ${Number(message.branch_total ?? 1)}`
      );
      if (message.created_at) lines.push(`- Time: ${message.created_at}`);
      if (message.model) lines.push(`- Model: \`${message.model}\``);
      lines.push("", String(message.text ?? ""), "", "---", "");
    });
  }

  if (webMessages.length && options.localOnlyIndexes.length) {
    lines.push("## TUI-only observations retained", "");
    options.localOnlyIndexes.forEach((localIndex, offset) => {
      const event = options.localEvents[localIndex] ?? {};
      const status = event.status ? ` · ${event.status}` : "";
      lines.push(
        `### TUI ${offset + 1} — ${normalizedRole(event.role).toUpperCase()} — tui-only${status}`,
        ""
      );
      if (event.observed_at) lines.push(`- Observed: ${event.observed_at}`);
      if (event.turn_id) lines.push(`- Turn ID: \`${event.turn_id}\``);
      lines.push("", String(event.text ?? ""), "", "---", "");
    });
  }

  if (!webMessages.length && options.localEvents.length) {
    lines.push("## Local TUI ledger", "");
    options.localEvents.forEach((event, index) => {
      const status = event.status ? ` · ${event.status}` : "";
      lines.push(
        `### TUI ${index + 1} — ${normalizedRole(event.role).toUpperCase()}${status}`,
        "",
        String(event.text ?? ""),
        "",
        "---",
        ""
      );
    });
  }

  return lines.join("\n").trimEnd() + "\n";
}

async function writeAtomic(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, text, "utf8");
  await fs.rename(temporary, filePath);
}

export async function readResolvedChatGPTContext(options: {
  chat: string;
  archiveRoot?: string;
  startLine?: number;
  maxLines?: number;
}): Promise<ReadResolvedChatGPTContextResult> {
  const id = conversationId(options.chat);
  const archiveRoot = path.resolve(expandHome(options.archiveRoot?.trim() || defaultArchiveRoot()));
  const filePath = path.join(archiveRoot, "resolved", id, "context.md");
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(
        `No resolved context exists for ${id}. Call resolve_chatgpt_context first.`
      );
    }
    throw error;
  }

  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;
  const startLine = Math.max(1, Math.floor(options.startLine ?? 1));
  const maxLines = Math.max(1, Math.min(2000, Math.floor(options.maxLines ?? 400)));
  const startIndex = Math.min(totalLines, startLine - 1);
  const endIndex = Math.min(totalLines, startIndex + maxLines);
  const selected = lines.slice(startIndex, endIndex);
  return {
    conversation_id: id,
    source_url: `https://chatgpt.com/c/${id}`,
    path: filePath,
    start_line: totalLines ? startIndex + 1 : 1,
    end_line: endIndex,
    total_lines: totalLines,
    next_start_line: endIndex < totalLines ? endIndex + 1 : null,
    text: selected.join("\n") + (selected.length ? "\n" : "")
  };
}

export async function resolveChatGPTContexts(options: {
  chats: string[];
  archiveRoot?: string;
}): Promise<ResolveChatGPTContextResult> {
  const chats = options.chats.map((value) => value.trim()).filter(Boolean);
  if (!chats.length) throw new Error("At least one ChatGPT conversation URL or ID is required.");
  if (chats.length > 20) throw new Error("At most 20 ChatGPT conversations can be resolved per call.");

  const refs = chats.map((chat) => ({
    chat,
    conversationId: conversationId(chat)
  }));
  const archiveRoot = path.resolve(expandHome(options.archiveRoot?.trim() || defaultArchiveRoot()));

  let remoteById = new Map<string, Record<string, unknown>>();
  let remoteFailure: string | null = null;
  try {
    const exported = await exportChatGPTChats({ chats });
    for (const item of exported.results) {
      const id =
        typeof item.conversation_id === "string"
          ? String(item.conversation_id).toLowerCase()
          : typeof item.chat === "string"
            ? safeConversationId(String(item.chat))
            : null;
      if (id) remoteById.set(id, item);
    }
  } catch (error) {
    remoteFailure = error instanceof Error ? error.message : String(error);
  }

  const results: ResolvedChatGPTContextItem[] = [];
  for (const ref of refs) {
    const conversationDir = path.join(archiveRoot, "conversations", ref.conversationId);
    const localEventsPath = path.join(conversationDir, "events.jsonl");
    const localTranscriptPath = path.join(conversationDir, "transcript.md");
    const localEvents = await readJsonLines(localEventsPath);
    const hasLocalEvents = localEvents.length > 0;

    const remote = remoteById.get(ref.conversationId);
    const webMarkdownPath =
      remote && remote.ok === true && typeof remote.path === "string" ? String(remote.path) : null;
    const webContextPath =
      remote && remote.ok === true && typeof remote.context_path === "string"
        ? String(remote.context_path)
        : null;
    const webContext = await readWebContext(webContextPath);
    const webMessages = safeWebMessages(webContext);
    const webAvailable = Boolean(webContext);
    const remoteError =
      remoteFailure ??
      (remote && remote.ok !== true ? String(remote.error ?? "canonical web export failed") : null);

    if (!hasLocalEvents && !webAvailable) {
      results.push({
        ok: false,
        conversation_id: ref.conversationId,
        source_url: `https://chatgpt.com/c/${ref.conversationId}`,
        status: "unavailable",
        local_events_path: null,
        local_transcript_path: null,
        web_markdown_path: webMarkdownPath,
        web_context_path: webContextPath,
        resolved_context_path: null,
        reconcile_state_path: null,
        counts: {
          local_events: 0,
          web_messages: 0,
          matched: 0,
          local_only: 0,
          web_only: 0,
          ambiguous: 0,
          branch_points: 0
        },
        error: remoteError ?? "Neither local TUI archive nor canonical web context is available."
      });
      continue;
    }

    const reconciled = reconcile(localEvents, webContext);
    const webOnly = Math.max(0, webMessages.length - reconciled.matchedWebIndexes.size);
    const status = reconciliationStatus({
      localCount: localEvents.length,
      webCount: webMessages.length,
      localOnly: reconciled.localOnlyIndexes.length,
      webOnly,
      webAvailable
    });

    const resolvedDir = path.join(archiveRoot, "resolved", ref.conversationId);
    const resolvedContextPath = path.join(resolvedDir, "context.md");
    const reconcileStatePath = path.join(resolvedDir, "state.json");
    const sourceUrl = `https://chatgpt.com/c/${ref.conversationId}`;
    const markdown = renderResolvedMarkdown({
      conversationId: ref.conversationId,
      sourceUrl,
      localEvents,
      webContext,
      webMarkdownPath,
      webContextPath,
      localEventsPath: hasLocalEvents ? localEventsPath : null,
      localTranscriptPath: hasLocalEvents ? localTranscriptPath : null,
      status,
      matchedWebIndexes: reconciled.matchedWebIndexes,
      localOnlyIndexes: reconciled.localOnlyIndexes,
      ambiguous: reconciled.ambiguous
    });
    await writeAtomic(resolvedContextPath, markdown);

    const state = {
      schema: 1,
      conversation_id: ref.conversationId,
      source_url: sourceUrl,
      reconciled_at: new Date().toISOString(),
      status,
      rule: "absence from canonical web is not deletion; retain local-only observations",
      local: {
        events_path: hasLocalEvents ? localEventsPath : null,
        transcript_path: hasLocalEvents ? localTranscriptPath : null,
        events: localEvents.length
      },
      web: {
        markdown_path: webMarkdownPath,
        context_path: webContextPath,
        messages: webMessages.length,
        branch_points: Number(webContext?.branch_points ?? 0),
        error: remoteError
      },
      counts: {
        matched: reconciled.matches.length,
        local_only: reconciled.localOnlyIndexes.length,
        web_only: webOnly,
        ambiguous: reconciled.ambiguous
      },
      matches: reconciled.matches
    };
    await writeAtomic(reconcileStatePath, JSON.stringify(state, null, 2) + "\n");

    results.push({
      ok: true,
      conversation_id: ref.conversationId,
      source_url: sourceUrl,
      status,
      local_events_path: hasLocalEvents ? localEventsPath : null,
      local_transcript_path: hasLocalEvents ? localTranscriptPath : null,
      web_markdown_path: webMarkdownPath,
      web_context_path: webContextPath,
      resolved_context_path: resolvedContextPath,
      reconcile_state_path: reconcileStatePath,
      counts: {
        local_events: localEvents.length,
        web_messages: webMessages.length,
        matched: reconciled.matches.length,
        local_only: reconciled.localOnlyIndexes.length,
        web_only: webOnly,
        ambiguous: reconciled.ambiguous,
        branch_points: Number(webContext?.branch_points ?? 0)
      },
      ...(remoteError ? { error: remoteError } : {})
    });
  }

  return {
    ok: results.every((item) => item.ok),
    count: results.length,
    resolved: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results
  };
}

function safeConversationId(value: string): string | null {
  try {
    return conversationId(value);
  } catch {
    return null;
  }
}
