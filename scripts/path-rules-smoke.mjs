import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TOKEN = randomBytes(32).toString('hex');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function textOf(result) {
  return result.content?.find?.((part) => part.type === 'text')?.text ?? '';
}

function proofOf(result) {
  const proof = result.structuredContent?.path_rules_required_proof;
  assert(proof && typeof proof === 'object' && !Array.isArray(proof), `expected path_rules_required_proof, got: ${JSON.stringify(proof)}`);
  return proof;
}

function withProof(args, result) {
  return { ...args, path_rules_proof: proofOf(result) };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    server.on('error', reject);
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for server\n${stderr}`)), 15000);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.includes('HTTP MCP listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early: ${code}\n${stderr}`));
    });
  });
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
}

async function writeRule(root, name, paths, body, exclude = []) {
  const dir = path.join(root, '.codex', 'path-rules');
  await fs.mkdir(dir, { recursive: true });
  const lines = ['---', 'paths:', ...paths.map((item) => `  - "${item}"`)];
  if (exclude.length) lines.push('exclude:', ...exclude.map((item) => `  - "${item}"`));
  lines.push('---', '', body, '');
  await fs.writeFile(path.join(dir, name), lines.join('\n'), 'utf8');
}

async function call(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-path-rules-smoke-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-path-rules-home-'));
const port = await freePort();

await fs.mkdir(path.join(root, 'tests', 'fixtures'), { recursive: true });
await fs.mkdir(path.join(root, 'src'), { recursive: true });
await fs.mkdir(path.join(root, 'migrations'), { recursive: true });
await fs.mkdir(path.join(root, 'docs'), { recursive: true });
await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
await fs.mkdir(path.join(root, 'global'), { recursive: true });
await fs.mkdir(path.join(root, 'subworkspace'), { recursive: true });
await fs.mkdir(path.join(root, 'cross'), { recursive: true });
await fs.writeFile(path.join(root, 'tests', 'sample.txt'), 'test sample\n', 'utf8');
await fs.writeFile(path.join(root, 'tests', 'fixtures', 'ignored.txt'), 'fixture\n', 'utf8');
await fs.writeFile(path.join(root, 'src', 'sample.txt'), 'src sample\n', 'utf8');
await fs.writeFile(path.join(root, 'migrations', '001.sql'), 'old\n', 'utf8');
await fs.writeFile(path.join(root, 'docs', 'guide.md'), 'guide\n', 'utf8');
await fs.writeFile(path.join(root, 'global', 'note.txt'), 'global\n', 'utf8');
await fs.writeFile(path.join(root, 'scripts', 'mutate.mjs'), "import fs from 'node:fs'; fs.writeFileSync('bash-ran.txt', 'ran\\n');\n", 'utf8');
await fs.writeFile(path.join(root, 'subworkspace', 'sub-sample.txt'), 'sub-sample content\n', 'utf8');

await writeRule(root, 'tests.md', ['tests/**'], 'TEST_RULE_MARKER_7F42', ['tests/fixtures/**']);
await writeRule(root, 'tests-second.md', ['tests/**'], 'SECOND_TEST_RULE_MARKER_E204', ['tests/fixtures/**']);
await writeRule(root, 'generated.md', ['generated/**'], 'WRITE_RULE_MARKER_91AC');
await writeRule(root, 'migrations.md', ['migrations/**'], 'PATCH_RULE_MARKER_C3D8');
await writeRule(root, 'docs.md', ['docs/**'], 'SUPERTOOL_RULE_MARKER_B6E1');
await writeRule(root, 'scripts.md', ['scripts/**'], 'BASH_RULE_MARKER_D502');
await writeRule(root, 'cross.md', ['cross/**'], 'CROSS_SESSION_RULE_MARKER_9B8C');
await writeRule(home, 'global.md', ['global/**'], 'GLOBAL_RULE_MARKER_A81E');

git(root, ['init']);
git(root, ['add', '.']);
git(root, ['-c', 'user.email=smoke@example.com', '-c', 'user.name=Smoke Test', 'commit', '-m', 'fixture']);

const child = spawn('node', ['dist/http.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    HOME: home,
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: root,
    CODEXPRO_HOST: '127.0.0.1',
    CODEXPRO_PORT: String(port),
    CODEXPRO_HTTP_TOKEN: TOKEN,
    CODEXPRO_TOOL_MODE: 'full',
    CODEXPRO_WRITE_MODE: 'workspace',
    CODEXPRO_BASH_MODE: 'full',
    CODEXPRO_PATH_RULES: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

try {
  await waitForListening(child);
  const client1 = new Client({ name: 'codexpro-path-rules-smoke-1', version: '0.0.0' });
  const transport1 = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
  });
  await client1.connect(transport1);

  const client2 = new Client({ name: 'codexpro-path-rules-smoke-2', version: '0.0.0' });
  const transport2 = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
  });
  await client2.connect(transport2);

  const client = client1;

  try {
    const config = await call(client, 'server_config');
    assert(!config.isError, `server_config failed: ${textOf(config)}`);
    assert(config.structuredContent?.pathRules?.enabled === true, 'path rules should be enabled');
    assert(config.structuredContent?.pathRules?.layerVersion === '0.2.0', 'unexpected path-rules layer version');
    assert(config.structuredContent?.pathRules?.proofMode === 'exact-rule-text', 'unexpected path-rules proof mode');
    assert(config.structuredContent?.pathRules?.proofField === 'path_rules_proof', 'unexpected path-rules proof field');
    const listedTools = (await client.listTools()).tools;
    for (const name of ['read', 'write', 'edit', 'apply_patch', 'bash']) {
      const tool = listedTools.find((item) => item.name === name);
      assert(tool?.inputSchema?.properties?.path_rules_proof, `${name} schema must expose path_rules_proof`);
    }

    const ignored = await call(client, 'read', { path: 'tests/fixtures/ignored.txt' });
    assert(!ignored.isError, `excluded path should not activate rule: ${textOf(ignored)}`);

    const readArgs = { path: 'tests/sample.txt' };
    const firstRead = await call(client, 'read', readArgs);
    assert(firstRead.isError, 'first matching read without proof must be blocked');
    assert(textOf(firstRead).includes('TEST_RULE_MARKER_7F42'), 'blocked read did not include rule body');
    assert(textOf(firstRead).includes('did not execute'), 'blocked read must state that it did not execute');
    const readProof = proofOf(firstRead);
    assert(Object.keys(readProof).length === 2, `expected two overlapping rule proofs, got ${Object.keys(readProof).length}`);
    assert(Object.values(readProof).some((value) => value.includes('TEST_RULE_MARKER_7F42')), 'required proof must contain the first canonical rule text');
    assert(Object.values(readProof).some((value) => value.includes('SECOND_TEST_RULE_MARKER_E204')), 'required proof must contain the second canonical rule text');

    const badProofRead = await call(client, 'read', { ...readArgs, path_rules_proof: Object.fromEntries(Object.keys(readProof).map((key) => [key, 'TEST_RULE_MARKER_7F42_WRONG'])) });
    assert(badProofRead.isError, 'wrong proof must not satisfy the rule');

    const firstProofKey = Object.keys(readProof)[0];
    const partialProofRead = await call(client, 'read', { ...readArgs, path_rules_proof: { [firstProofKey]: readProof[firstProofKey] } });
    assert(partialProofRead.isError, 'partial proof must not satisfy overlapping rules');
    assert(Object.keys(proofOf(partialProofRead)).length === 2, 'partial-proof block must return the complete proof set to avoid proof ping-pong');

    const retriedRead = await call(client, 'read', withProof(readArgs, firstRead));
    assert(!retriedRead.isError, `retry with exact proof should succeed: ${textOf(retriedRead)}`);
    const repeatedRead = await call(client, 'read', withProof(readArgs, firstRead));
    assert(!repeatedRead.isError, 'same exact proof should keep satisfying the rule');
    const forgottenRead = await call(client, 'read', readArgs);
    assert(forgottenRead.isError, 'dropping proof must re-activate the rule even in the same session');

    const normalRead = await call(client, 'read', { path: 'src/sample.txt' });
    assert(!normalRead.isError, `unmatched path should pass: ${textOf(normalRead)}`);

    const globalArgs = { path: 'global/note.txt' };
    const firstGlobal = await call(client, 'read', globalArgs);
    assert(firstGlobal.isError, 'global rule should activate');
    assert(textOf(firstGlobal).includes('GLOBAL_RULE_MARKER_A81E'), 'global rule body was not delivered');
    const retriedGlobal = await call(client, 'read', withProof(globalArgs, firstGlobal));
    assert(!retriedGlobal.isError, `global rule retry with proof should succeed: ${textOf(retriedGlobal)}`);

    const bashArgs = { command: 'node scripts/mutate.mjs' };
    const firstBash = await call(client, 'bash', bashArgs);
    assert(firstBash.isError, 'bash path should activate rule before command execution');
    assert(textOf(firstBash).includes('BASH_RULE_MARKER_D502'), 'bash activation did not include rule body');
    let bashRan = true;
    try {
      await fs.stat(path.join(root, 'bash-ran.txt'));
    } catch {
      bashRan = false;
    }
    assert(!bashRan, 'blocked bash command executed unexpectedly');
    const retriedBash = await call(client, 'bash', withProof(bashArgs, firstBash));
    assert(!retriedBash.isError, `retried bash with proof should succeed: ${textOf(retriedBash)}`);
    assert((await fs.readFile(path.join(root, 'bash-ran.txt'), 'utf8')) === 'ran\n', 'retried bash command did not execute');

    const writeArgs = { path: 'generated/new.txt', content: 'created\n' };
    const firstWrite = await call(client, 'write', writeArgs);
    assert(firstWrite.isError, 'first matching write must be blocked');
    assert(textOf(firstWrite).includes('WRITE_RULE_MARKER_91AC'), 'blocked write did not include rule body');
    let created = true;
    try {
      await fs.stat(path.join(root, 'generated', 'new.txt'));
    } catch {
      created = false;
    }
    assert(!created, 'blocked write executed unexpectedly');
    const retriedWrite = await call(client, 'write', withProof(writeArgs, firstWrite));
    assert(!retriedWrite.isError, `retried write with proof should succeed: ${textOf(retriedWrite)}`);
    assert((await fs.readFile(path.join(root, 'generated', 'new.txt'), 'utf8')) === 'created\n', 'retried write did not execute');

    const patch = ['--- a/migrations/001.sql', '+++ b/migrations/001.sql', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
    const patchArgs = { patch };
    const firstPatch = await call(client, 'apply_patch', patchArgs);
    assert(firstPatch.isError, 'first matching apply_patch must be blocked');
    assert(textOf(firstPatch).includes('PATCH_RULE_MARKER_C3D8'), 'blocked patch did not include rule body');
    assert((await fs.readFile(path.join(root, 'migrations', '001.sql'), 'utf8')) === 'old\n', 'blocked patch changed the file');
    const retriedPatch = await call(client, 'apply_patch', withProof(patchArgs, firstPatch));
    assert(!retriedPatch.isError, `retried patch with proof should succeed: ${textOf(retriedPatch)}`);
    assert((await fs.readFile(path.join(root, 'migrations', '001.sql'), 'utf8')) === 'new\n', 'retried patch did not execute');

    const supertoolArgs = { path: 'docs/guide.md' };
    const firstSupertool = await call(client, 'codexpro', { action: 'read', args: supertoolArgs });
    assert(firstSupertool.isError, 'supertool child path should activate rule');
    assert(textOf(firstSupertool).includes('SUPERTOOL_RULE_MARKER_B6E1'), 'supertool activation did not include rule body');
    const retriedSupertool = await call(client, 'codexpro', { action: 'read', args: withProof(supertoolArgs, firstSupertool) });
    assert(!retriedSupertool.isError, `retried supertool read with proof should succeed: ${textOf(retriedSupertool)}`);

    await writeRule(root, 'tests.md', ['tests/**'], 'TEST_RULE_UPDATED_MARKER_44D2', ['tests/fixtures/**']);
    const changedRule = await call(client, 'read', { ...readArgs, path_rules_proof: readProof });
    assert(changedRule.isError, 'old proof must fail after rule content changes');
    assert(textOf(changedRule).includes('TEST_RULE_UPDATED_MARKER_44D2'), 'updated rule body was not delivered');
    const retriedChangedRule = await call(client, 'read', withProof(readArgs, changedRule));
    assert(!retriedChangedRule.isError, 'updated exact rule proof should allow the call');

    // Cross-session workspace_id reuse test
    const openRoot = await call(client1, 'open_current_workspace');
    assert(!openRoot.isError, `open_current_workspace failed: ${textOf(openRoot)}`);
    const rootWsId = openRoot.structuredContent?.workspace_id ?? openRoot.structuredContent?.id;
    assert(typeof rootWsId === 'string' && rootWsId.startsWith('ws_'), `expected root workspace_id string, got: ${rootWsId}`);

    const openSub = await call(client1, 'open_workspace', { root: path.join(root, 'subworkspace') });
    assert(!openSub.isError, `open_workspace on client1 failed: ${textOf(openSub)}`);
    const subWsId = openSub.structuredContent?.workspace_id ?? openSub.structuredContent?.id;
    assert(typeof subWsId === 'string' && subWsId.startsWith('ws_'), `expected workspace_id string, got: ${subWsId}`);

    const crossWsRead = await call(client2, 'read', { workspace_id: subWsId, path: 'sub-sample.txt' });
    assert(!crossWsRead.isError, `cross-session workspace read in client2 failed: ${textOf(crossWsRead)}`);
    assert(textOf(crossWsRead).includes('sub-sample content'), 'cross-session workspace read returned unexpected content');

    const listRes = await call(client2, 'list_workspaces');
    assert(!listRes.isError, `list_workspaces on client2 failed: ${textOf(listRes)}`);
    const listedIds = listRes.structuredContent?.workspaces?.map((w) => w.id) ?? [];
    assert(listedIds.includes(subWsId), `list_workspaces on client2 should contain shared workspace ${subWsId}`);

    // Cross-session proof test: proof is model/context state, not MCP-session state.
    const crossWriteArgs = { workspace_id: rootWsId, path: 'cross/output.txt', content: 'cross session content\n' };
    const firstCrossWrite = await call(client1, 'write', crossWriteArgs);
    assert(firstCrossWrite.isError, 'first cross-session write without proof must be blocked');
    assert(textOf(firstCrossWrite).includes('CROSS_SESSION_RULE_MARKER_9B8C'), 'blocked cross write did not include rule body');
    assert(textOf(firstCrossWrite).includes('did not execute'), 'blocked cross write must state non-execution');
    let crossCreated = true;
    try {
      await fs.stat(path.join(root, 'cross', 'output.txt'));
    } catch {
      crossCreated = false;
    }
    assert(!crossCreated, 'blocked cross write executed unexpectedly');

    const crossProof = proofOf(firstCrossWrite);
    const retriedCrossWrite = await call(client2, 'write', { ...crossWriteArgs, path_rules_proof: crossProof });
    assert(!retriedCrossWrite.isError, `exact proof should work across MCP sessions: ${textOf(retriedCrossWrite)}`);
    assert((await fs.readFile(path.join(root, 'cross', 'output.txt'), 'utf8')) === 'cross session content\n', 'retried cross write did not execute');

    const repeatedCrossRead = await call(client2, 'read', { workspace_id: rootWsId, path: 'cross/output.txt', path_rules_proof: crossProof });
    assert(!repeatedCrossRead.isError, `same proof should satisfy a different tool action touching the same rule: ${textOf(repeatedCrossRead)}`);

    const newActionWithProof = await call(client1, 'write', { workspace_id: rootWsId, path: 'cross/other.txt', content: 'other\n', path_rules_proof: crossProof });
    assert(!newActionWithProof.isError, `new action with retained rule text should not be blocked: ${textOf(newActionWithProof)}`);
    assert((await fs.readFile(path.join(root, 'cross', 'other.txt'), 'utf8')) === 'other\n', 'new action with proof did not execute');

    const forgottenCrossProof = await call(client1, 'read', { workspace_id: rootWsId, path: 'cross/output.txt' });
    assert(forgottenCrossProof.isError, 'simulated compaction (proof omitted) must re-inject the rule');
    assert(textOf(forgottenCrossProof).includes('CROSS_SESSION_RULE_MARKER_9B8C'), 'simulated compaction did not re-deliver rule text');

    console.log('PATH_RULES_SMOKE_OK');
  } finally {
    await Promise.allSettled([client1.close(), client2.close()]);
  }
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
}

if (stderr.includes('[codexpro-path-rules] skipping unreadable rule')) {
  throw new Error(`path-rules smoke emitted rule parse/read errors:\n${stderr}`);
}
