import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function encode(message) {
  return JSON.stringify(message) + '\n';
}

class McpStdioClient {
  constructor(command, args, options) {
    this.child = spawn(command, args, options);
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.child.on('exit', (code) => {
      for (const pending of this.pending.values()) pending.reject(new Error('server exited ' + code));
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for ' + method)), 15000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(encode({ jsonrpc: '2.0', method, params }));
  }

  close() {
    this.child.kill('SIGTERM');
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-chatgpt-context-smoke-'));
const archiveRoot = path.join(tmp, 'gptty-archive');
const exportDir = path.join(tmp, 'exports');
const stubPath = path.join(tmp, 'fake-exporter.mjs');
const conversationId = '11111111-1111-4111-8111-111111111111';
const chat = 'https://chatgpt.com/c/' + conversationId;
const localDir = path.join(archiveRoot, 'conversations', conversationId);
await fs.mkdir(localDir, { recursive: true });
await fs.mkdir(exportDir, { recursive: true });

const longLocalOnly = Array.from(
  { length: 1400 },
  (_, index) => 'local-only-long-line-' + String(index + 1).padStart(4, '0')
).join('\n') + '\nATOMIC_CONTEXT_END_SENTINEL';
const localEvents = [
  { schema: 1, event_id: 't1:user', turn_id: 't1', role: 'user', text: 'hello', scope: 'tui-observed' },
  { schema: 1, event_id: 't1:assistant', turn_id: 't1', role: 'assistant', text: longLocalOnly, scope: 'tui-observed', status: 'complete' },
  { schema: 1, event_id: 't2:user', turn_id: 't2', role: 'user', text: 'shared question', scope: 'tui-observed' },
  { schema: 1, event_id: 't2:assistant', turn_id: 't2', role: 'assistant', text: 'shared answer', scope: 'tui-observed', status: 'complete' }
];
await fs.writeFile(
  path.join(localDir, 'events.jsonl'),
  localEvents.map((item) => JSON.stringify(item)).join('\n') + '\n',
  'utf8'
);
await fs.writeFile(path.join(localDir, 'transcript.md'), '# local transcript\n', 'utf8');

const stubSource = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "const chats = process.argv.slice(2).filter((value, index, all) => all[index - 1] !== '--output-dir' && value !== '--output-dir');",
  "const outputDir = " + JSON.stringify(exportDir) + ";",
  "fs.mkdirSync(outputDir, { recursive: true });",
  "const results = chats.map((chat) => {",
  "  const id = chat.includes('/c/') ? chat.split('/c/')[1].split(/[/?#]/)[0].toLowerCase() : chat.toLowerCase();",
  "  const markdownPath = path.join(outputDir, 'web -- ' + id + '.md');",
  "  const contextPath = path.join(outputDir, 'web -- ' + id + '.context.json');",
  "  fs.writeFileSync(markdownPath, '# canonical web\\n');",
  "  fs.writeFileSync(contextPath, JSON.stringify({",
  "    schema: 1, conversation_id: id, source_url: 'https://chatgpt.com/c/' + id, title: 'Web',",
  "    scope: 'canonical-web-visible', current_node_id: 'a-shared', branch_points: 1, leaf_branches: 2,",
  "    messages: [",
  "      { id: 'u-hello', parent_id: null, role: 'user', text: 'hello', current_branch: true, branch_index: 1, branch_total: 1 },",
  "      { id: 'a-web', parent_id: 'u-hello', role: 'assistant', text: 'web branch only', current_branch: false, branch_index: 1, branch_total: 2 },",
  "      { id: 'u-shared', parent_id: 'u-hello', role: 'user', text: 'shared question', current_branch: true, branch_index: 2, branch_total: 2 },",
  "      { id: 'a-shared', parent_id: 'u-shared', role: 'assistant', text: 'shared answer', current_branch: true, branch_index: 1, branch_total: 1 }",
  "    ]",
  "  }, null, 2));",
  "  return { ok: true, chat, path: markdownPath, context_path: contextPath, conversation_id: id };",
  "});",
  "process.stdout.write(JSON.stringify({ ok: true, count: results.length, exported: results.length, failed: 0, results }));"
].join('\n');
await fs.writeFile(stubPath, stubSource, 'utf8');

let fakeCommand;
if (process.platform === 'win32') {
  fakeCommand = path.join(tmp, 'fake-exporter.cmd');
  await fs.writeFile(fakeCommand, '@"' + process.execPath + '" "' + stubPath + '" %*\r\n', 'utf8');
} else {
  fakeCommand = path.join(tmp, 'fake-exporter');
  await fs.writeFile(fakeCommand, '#!/bin/sh\nexec "' + process.execPath + '" "' + stubPath + '" "$@"\n', 'utf8');
  await fs.chmod(fakeCommand, 0o755);
}

const client = new McpStdioClient(
  process.execPath,
  ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'off', '--tool-mode', 'standard'],
  {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_ROOT: tmp,
      CODEXPRO_ALLOWED_ROOTS: tmp,
      CODEXPRO_CHATGPT_EXPORTER: fakeCommand,
      GPTTY_ARCHIVE_HOME: archiveRoot,
      CODEXPRO_TOOL_CARDS: '0'
    }
  }
);

try {
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codexpro-chatgpt-context-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');

  const tools = await client.request('tools/list', {});
  const resolver = tools.tools.find((tool) => tool.name === 'resolve_chatgpt_context');
  if (!resolver) throw new Error('resolve_chatgpt_context is not registered in standard tool mode');
  if (!String(resolver.description || '').includes('Default tool')) {
    throw new Error('resolver descriptor is not explicit enough: ' + resolver.description);
  }
  if (!tools.tools.some((tool) => tool.name === 'read_chatgpt_context')) {
    throw new Error('read_chatgpt_context is not registered in standard tool mode');
  }

  const wrapped = await client.request('tools/call', {
    name: 'codexpro',
    arguments: { action: 'list_actions', args: {} }
  });
  if (!wrapped.structuredContent?.actions?.includes('resolve_chatgpt_context')) {
    throw new Error('supertool does not expose resolver: ' + JSON.stringify(wrapped.structuredContent));
  }

  const wrappedResolve = await client.request('tools/call', {
    name: 'codexpro',
    arguments: { action: 'resolve_chatgpt_context', chat }
  });
  if (wrappedResolve.isError) {
    throw new Error('supertool resolver shorthand failed: ' + JSON.stringify(wrappedResolve));
  }
  const wrappedText = (wrappedResolve.content || []).map((part) => part.text || '').join('\n');
  if (
    !wrappedText.includes('ATOMIC_CONTEXT_END_SENTINEL') ||
    !wrappedText.includes('# DELIVERY COMPLETE · ' + conversationId)
  ) {
    throw new Error('supertool shorthand did not deliver complete reconciled context');
  }
  if (wrappedResolve.structuredContent?.codexpro_super_action !== 'resolve_chatgpt_context') {
    throw new Error(
      'supertool did not preserve wrapped resolver identity: ' +
        JSON.stringify(wrappedResolve.structuredContent)
    );
  }

  const call = await client.request('tools/call', {
    name: 'resolve_chatgpt_context',
    arguments: { chats: [chat] }
  });
  if (call.isError) throw new Error('resolver MCP call failed: ' + JSON.stringify(call));
  const item = call.structuredContent?.results?.[0];
  if (!item || item.status !== 'diverged') {
    throw new Error('expected diverged reconciliation: ' + JSON.stringify(call.structuredContent));
  }
  if (
    item.counts?.matched !== 3 ||
    item.counts?.local_only !== 1 ||
    item.counts?.web_only !== 1 ||
    item.counts?.branch_points !== 1
  ) {
    throw new Error('unexpected reconciliation counts: ' + JSON.stringify(item.counts));
  }
  const responseText = (call.content || []).map((part) => part.text || '').join('\n');
  if (!responseText.includes('ATOMIC_CONTEXT_END_SENTINEL') || !responseText.includes('web branch only')) {
    throw new Error('resolver response itself did not include the complete reconciled context');
  }
  if (!(call.content?.length > 3)) {
    throw new Error('expected the complete context to be split into multiple content blocks');
  }
  if (!responseText.includes('# DELIVERY COMPLETE · ' + conversationId)) {
    throw new Error('atomic delivery completion receipt is missing');
  }
  const delivery = call.structuredContent?.deliveries?.[0];
  if (!delivery?.complete || delivery.blocks < 2 || !delivery.sha256 || !delivery.bytes) {
    throw new Error('structured delivery receipt is incomplete: ' + JSON.stringify(delivery));
  }

  const resolved = await fs.readFile(item.resolved_context_path, 'utf8');
  if (!resolved.includes('ATOMIC_CONTEXT_END_SENTINEL') || !resolved.includes('web branch only')) {
    throw new Error('resolved context did not retain both local-only and web-only content');
  }
  if (!resolved.includes('tui-only') || !resolved.includes('web-only')) {
    throw new Error('resolved context is missing provenance labels');
  }

  const state = JSON.parse(await fs.readFile(item.reconcile_state_path, 'utf8'));
  if (state.rule !== 'absence from canonical web is not deletion; retain local-only observations') {
    throw new Error('reconciliation safety rule missing: ' + JSON.stringify(state));
  }
} finally {
  client.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log('✓ ChatGPT context reconciliation MCP smoke test passed');
