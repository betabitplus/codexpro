import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { minimatch } from "minimatch";
import { isSubpath, normalizeRelPath, type Workspace, type WorkspaceManager } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

export const PATH_RULES_LAYER_VERSION = "0.2.0";
export const PATH_RULES_LOCAL_DIR = ".codex/path-rules";
export const PATH_RULES_PROOF_FIELD = "path_rules_proof";

type Rule = {
  source: string;
  displaySource: string;
  paths: string[];
  exclude: string[];
  body: string;
  id: string;
};

const DIRECT_PATH_KEYS: Record<string, string[]> = {
  tree: ["path"],
  search: ["path"],
  read: ["path"],
  view_image: ["path"],
  write: ["path"],
  edit: ["path"],
  import_file: ["destination"],
  git_status: ["path"],
  git_diff: ["path"],
  show_changes: ["path"],
  inspect_workspace: ["path"],
  codex_context: ["target_path"]
};

export function pathRulesApplyToTool(toolName: string): boolean {
  return toolName in DIRECT_PATH_KEYS || toolName === "apply_patch" || toolName === "bash";
}

export class PathRuleActivationError extends Error {
  constructor(message: string, readonly requiredProof: Record<string, string>) {
    super(message);
    this.name = "PathRuleActivation";
  }
}

function parseFrontmatterList(lines: string[], key: string): string[] {
  const values: string[] = [];
  let active = false;
  const keyPattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*$`);
  const anyKeyPattern = /^[A-Za-z_][A-Za-z0-9_-]*\s*:/;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (keyPattern.test(line)) {
      active = true;
      continue;
    }
    if (anyKeyPattern.test(line)) {
      active = false;
      continue;
    }
    if (!active) continue;
    const match = line.match(/^\s*-\s*(.+?)\s*$/);
    if (!match) continue;
    let value = match[1].trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    if (value) values.push(value);
  }
  return values;
}

function parseRule(rulePath: string, repoRoot: string): Rule | undefined {
  const text = fs.readFileSync(rulePath, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end < 0) return undefined;

  const header = lines.slice(1, end);
  const paths = parseFrontmatterList(header, "paths");
  if (!paths.length) return undefined;
  const exclude = parseFrontmatterList(header, "exclude");
  const body = `${lines.slice(end + 1).join("\n").replace(/^\n+|\s+$/g, "")}\n`;
  const resolved = fs.realpathSync.native(rulePath);
  const id = createHash("sha256").update(`${resolved}\0${text}`).digest("hex").slice(0, 20);
  const displaySource = isSubpath(resolved, repoRoot)
    ? normalizeRelPath(path.relative(repoRoot, resolved))
    : resolved;

  return { source: resolved, displaySource, paths, exclude, body, id };
}

function findRepoRoot(workspaceRoot: string): string {
  let current = fs.realpathSync.native(workspaceRoot);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return fs.realpathSync.native(workspaceRoot);
    current = parent;
  }
}

function discoverRules(repoRoot: string): Rule[] {
  const home = process.env.HOME || os.homedir();
  const directories = [path.join(home, ".codex", "path-rules"), path.join(repoRoot, PATH_RULES_LOCAL_DIR)];
  const seen = new Set<string>();
  const rules: Rule[] = [];

  for (const directory of directories) {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) continue;
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
    for (const entry of entries) {
      const candidate = path.join(directory, entry);
      try {
        const resolved = fs.realpathSync.native(candidate);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        const rule = parseRule(resolved, repoRoot);
        if (rule) rules.push(rule);
      } catch (error) {
        console.error(`[codexpro-path-rules] skipping unreadable rule ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return rules;
}

function normalizePattern(pattern: string): string {
  return pattern.replace(/\\/g, "/").replace(/^\.\//, "");
}

function patternMatches(relPath: string, patterns: string[]): boolean {
  const rel = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const rawPattern of patterns) {
    const pattern = normalizePattern(rawPattern);
    if (!pattern) continue;
    if (minimatch(rel, pattern, { dot: true, nocase: false, matchBase: false, nonegate: true, nocomment: true })) return true;
    if (pattern.endsWith("/**")) {
      const base = pattern.slice(0, -3).replace(/\/$/, "");
      if (rel === base) return true;
    }
  }
  return false;
}

function stripPathDecoration(raw: string): string {
  let value = raw.trim();
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    value = value.slice(1, -1);
  }
  value = value.replace(/:\d+(?::\d+)?$/, "").replace(/[,;)]+$/, "");
  return value;
}

function toRepoRelative(raw: string, baseDir: string, repoRoot: string): string | undefined {
  let value = stripPathDecoration(raw);
  if (!value || value.startsWith("-") || value.includes("\n") || value.includes("://")) return undefined;
  if (value.startsWith("~/")) value = path.join(process.env.HOME || os.homedir(), value.slice(2));
  const absolute = path.resolve(path.isAbsolute(value) ? value : path.join(baseDir, value));
  if (!isSubpath(absolute, repoRoot)) return undefined;
  return normalizeRelPath(path.relative(repoRoot, absolute) || ".");
}

function patchPaths(patchText: string): string[] {
  const found: string[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    let match = line.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/);
    if (match) {
      found.push(match[1]);
      continue;
    }
    match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      found.push(match[1], match[2]);
      continue;
    }
    match = line.match(/^(?:\+\+\+|---) (?:[ab]\/)?(.+)$/);
    if (match && match[1] !== "/dev/null") found.push(match[1]);
  }
  return found;
}

function shellTokens(command: string): string[] {
  return command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) ?? [];
}

function shellPathCandidates(command: string, cwd: string): string[] {
  const found: string[] = [];
  for (const rawToken of shellTokens(command)) {
    const token = stripPathDecoration(rawToken).replace(/^[<>|;&()]+|[<>|;&()]+$/g, "");
    if (!token || token.startsWith("-") || token.includes("://")) continue;
    const looksLikePath =
      token.includes("/") ||
      ["tests", "test", "src", "lib", "docs", "examples"].includes(token) ||
      /\.[A-Za-z0-9_+-]{1,12}(?::\d+(?::\d+)?)?$/.test(token) ||
      fs.existsSync(path.resolve(cwd, token));
    if (looksLikePath) found.push(token);
  }
  return found;
}

function collectToolPaths(toolName: string, args: any, workspace: Workspace, repoRoot: string): string[] {
  const raw: Array<{ value: string; baseDir: string }> = [];
  const workspaceBase = workspace.root;

  for (const key of DIRECT_PATH_KEYS[toolName] ?? []) {
    const value = args?.[key];
    if (typeof value === "string") raw.push({ value, baseDir: workspaceBase });
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") raw.push({ value: item, baseDir: workspaceBase });
    }
  }

  if (toolName === "apply_patch" && typeof args?.patch === "string") {
    for (const value of patchPaths(args.patch)) raw.push({ value, baseDir: workspaceBase });
  }

  if (toolName === "bash" && typeof args?.command === "string") {
    const bashCwd = typeof args.cwd === "string" ? path.resolve(workspaceBase, args.cwd) : workspaceBase;
    for (const value of shellPathCandidates(args.command, bashCwd)) raw.push({ value, baseDir: bashCwd });
  }

  const normalized: string[] = [];
  for (const item of raw) {
    const rel = toRepoRelative(item.value, item.baseDir, repoRoot);
    if (rel && !normalized.includes(rel)) normalized.push(rel);
  }
  return normalized;
}

function canonicalProofText(rule: Rule): string {
  return redactSensitiveText(rule.body.trimEnd());
}

function requiredProofForRules(rules: Rule[]): Record<string, string> {
  return Object.fromEntries(rules.map((rule) => [rule.id, canonicalProofText(rule)]));
}

function activatedMessage(rules: Rule[], paths: string[], requiredProof: Record<string, string>): string {
  const sections = [
    "PATH-SCOPED RULES ACTIVATED",
    `This CodexPro tool call was blocked before execution because it touches: ${paths.join(", ")}.`,
    "Apply these instructions and re-evaluate the pending action.",
    `If you still want to perform the action, retry it with the exact ${PATH_RULES_PROOF_FIELD} argument shown below. Keep supplying the exact proof text on later calls that touch the same rule; do not abbreviate it or replace it with only a hash/nonce.`
  ];
  for (const rule of rules) {
    sections.push(`\n--- rule: ${rule.displaySource} ---\n${rule.body.trimEnd()}`);
  }
  sections.push(`\nRequired proof argument:\n${JSON.stringify({ [PATH_RULES_PROOF_FIELD]: requiredProof }, null, 2)}`);
  sections.push("\nThe pending tool call did not execute.");
  return sections.join("\n");
}

export class PathRulesGate {
  readonly enabled: boolean;

  constructor(private readonly workspaces: WorkspaceManager) {
    const raw = String(process.env.CODEXPRO_PATH_RULES ?? "1").trim().toLowerCase();
    this.enabled = !["0", "false", "off", "no"].includes(raw);
  }

  status(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      layerVersion: PATH_RULES_LAYER_VERSION,
      localRuleDir: PATH_RULES_LOCAL_DIR,
      globalRuleDir: path.join(process.env.HOME || os.homedir(), ".codex", "path-rules"),
      proofMode: "exact-rule-text",
      proofField: PATH_RULES_PROOF_FIELD
    };
  }

  beforeTool(toolName: string, args: any): void {
    if (!this.enabled) return;
    if (!pathRulesApplyToTool(toolName)) return;

    let workspace: Workspace;
    try {
      workspace = this.workspaces.getWorkspace(typeof args?.workspace_id === "string" ? args.workspace_id : undefined);
    } catch {
      return;
    }

    const repoRoot = findRepoRoot(workspace.root);
    const paths = collectToolPaths(toolName, args ?? {}, workspace, repoRoot);
    if (!paths.length) return;
    const rules = discoverRules(repoRoot).filter((rule) =>
      paths.some((relPath) => patternMatches(relPath, rule.paths) && !patternMatches(relPath, rule.exclude))
    );
    if (!rules.length) return;

    const suppliedProof = args?.[PATH_RULES_PROOF_FIELD];
    const proof = suppliedProof && typeof suppliedProof === "object" && !Array.isArray(suppliedProof)
      ? suppliedProof as Record<string, unknown>
      : {};
    const missingRules = rules.filter((rule) => proof[rule.id] !== canonicalProofText(rule));
    if (!missingRules.length) return;

    const requiredProof = requiredProofForRules(rules);
    throw new PathRuleActivationError(activatedMessage(missingRules, paths, requiredProof), requiredProof);
  }
}
