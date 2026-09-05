import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportChatGPTChats } from '../dist/chatgptExportOps.js';

function encode(message) {
  return `${JSON.stringify(message)}\n`;
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
      for (const { reject } of this.pending.values()) reject(new Error(`server exited ${code}`));
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
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-chatgpt-export-smoke-'));
const stubPath = path.join(tmp, 'fake-exporter.mjs');
const outputDir = path.join(tmp, 'exports');
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  stubPath,
  [
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "let outputDir = path.resolve('fallback');",
    "const chats = [];",
    "for (let i = 0; i < args.length; i += 1) {",
    "  if (args[i] === '--output-dir') { outputDir = path.resolve(args[++i]); continue; }",
    "  chats.push(args[i]);",
    "}",
    "const results = chats.map((chat, index) => ({ ok: true, chat, path: path.join(outputDir, `chat-${index + 1}.md`) }));",
    "process.stdout.write(JSON.stringify({ ok: true, count: results.length, exported: results.length, failed: 0, results }));"
  ].join('\n'),
  'utf8'
);

let fakeCommand;
if (process.platform === 'win32') {
  fakeCommand = path.join(tmp, 'fake-exporter.cmd');
  await fs.writeFile(fakeCommand, `@\"${process.execPath}\" \"${stubPath}\" %*\r\n`, 'utf8');
} else {
  fakeCommand = path.join(tmp, 'fake-exporter');
  await fs.writeFile(fakeCommand, `#!/bin/sh\nexec \"${process.execPath}\" \"${stubPath}\" \"$@\"\n`, 'utf8');
  await fs.chmod(fakeCommand, 0o755);
}

const first = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
const second = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222;touch-never-runs';

const direct = await exportChatGPTChats({ chats: [first, second], outputDir, command: fakeCommand });
if (!direct.ok || direct.exported !== 2 || direct.results[1]?.chat !== second) {
  throw new Error(`direct exporter wrapper failed: ${JSON.stringify(direct)}`);
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
      CODEXPRO_TOOL_CARDS: '0'
    }
  }
);

try {
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codexpro-chatgpt-export-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');

  const tools = await client.request('tools/list', {});
  if (!tools.tools.some((tool) => tool.name === 'export_chatgpt_chats')) {
    throw new Error('export_chatgpt_chats is not registered in standard tool mode');
  }

  const call = await client.request('tools/call', {
    name: 'export_chatgpt_chats',
    arguments: { chats: [first, second] }
  });
  if (call.isError) throw new Error(`MCP export failed: ${JSON.stringify(call)}`);
  if (call.structuredContent?.exported !== 2 || call.structuredContent?.failed !== 0) {
    throw new Error(`unexpected MCP export result: ${JSON.stringify(call.structuredContent)}`);
  }
  if (!Array.isArray(call.structuredContent?.paths) || call.structuredContent.paths.length !== 2) {
    throw new Error(`MCP export paths missing: ${JSON.stringify(call.structuredContent)}`);
  }
  if (call.structuredContent?.results?.[1]?.chat !== second) {
    throw new Error(`chat argument was not preserved literally: ${JSON.stringify(call.structuredContent)}`);
  }
} finally {
  client.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log('✓ ChatGPT exporter MCP smoke test passed');
