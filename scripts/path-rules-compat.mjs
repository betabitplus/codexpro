import fs from 'node:fs/promises';

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function requireCount(failures, text, needle, expected, label) {
  const actual = count(text, needle);
  if (actual !== expected) failures.push(`${label}: expected ${expected}, found ${actual}`);
}

const [server, guard, packageText, pathRules] = await Promise.all([
  fs.readFile('src/server.ts', 'utf8'),
  fs.readFile('src/guard.ts', 'utf8'),
  fs.readFile('package.json', 'utf8'),
  fs.readFile('src/pathRules.ts', 'utf8')
]);
const pkg = JSON.parse(packageText);
const failures = [];

requireCount(failures, server, 'function registerCodexTool(', 1, 'central registerCodexTool seam');
requireCount(
  failures,
  server,
  'pathRulesGatesByServer.get(server as object)?.beforeTool(name, validatedArgs);',
  1,
  'pre-tool path-rules middleware call'
);
requireCount(
  failures,
  server,
  'const effectiveOptions = optionsWithPathRulesProof(name, options);',
  1,
  'path-rules proof schema injection seam'
);
requireCount(
  failures,
  server,
  'rememberRegisteredToolHandler(server, name, validatedHandler);',
  1,
  'supertool must retain the gated validated handler'
);
requireCount(
  failures,
  server,
  'result = await handler(childArgs, extra);',
  1,
  'supertool must propagate request handler extra'
);
requireCount(failures, server, 'const workspaces = new WorkspaceManager(config);', 1, 'WorkspaceManager construction seam');
requireCount(failures, server, 'const pathRulesGate = new PathRulesGate(workspaces);', 1, 'PathRulesGate construction');
requireCount(
  failures,
  server,
  'pathRulesGatesByServer.set(server as object, pathRulesGate);',
  1,
  'PathRulesGate server-session binding'
);
requireCount(failures, server, 'pathRules: pathRulesGate.status(),', 1, 'server_config path-rules status');

if (!guard.includes('export class WorkspaceManager')) failures.push('WorkspaceManager export is missing');
if (!guard.includes('getWorkspace(id?: string): Workspace')) failures.push('WorkspaceManager.getWorkspace API changed');
if (!guard.includes('root: string;')) failures.push('Workspace.root API changed');
if (!guard.includes('sharedWorkspaces')) failures.push('process-level shared workspace registry is missing');
if (!pkg.dependencies?.minimatch) failures.push('minimatch dependency is missing');
if (!pathRules.includes('export class PathRulesGate')) failures.push('PathRulesGate implementation is missing');
if (!pathRules.includes('export const PATH_RULES_PROOF_FIELD = "path_rules_proof"')) failures.push('path_rules_proof field definition is missing');
if (!pathRules.includes('proofMode: "exact-rule-text"')) failures.push('exact-rule-text proof mode is missing');
if (!pathRules.includes('proof[rule.id] !== canonicalProofText(rule)')) failures.push('exact proof validation is missing');
if (pathRules.includes('pendingHandshakes') || pathRules.includes('sessionLoadedRules')) failures.push('legacy session/handshake cache must not decide proof validity');
if (!server.includes('path_rules_required_proof')) failures.push('structured required-proof output is missing');
if (!server.includes('[PATH_RULES_PROOF_FIELD]: z.record(z.string()).optional()')) failures.push('tool schema does not expose path_rules_proof');
if (!pathRules.includes('The pending tool call did not execute.')) failures.push('block result no longer explicitly states non-execution');

if (failures.length) {
  console.error('PATH_RULES_COMPAT_FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error('Upstream changed a path-rules integration assumption. Do not install/restart this fork until src/server.ts, src/guard.ts, and the MCP smoke test are re-audited.');
  process.exit(1);
}

console.log('PATH_RULES_COMPAT_OK');
