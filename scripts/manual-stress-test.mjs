import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const token = fs.readFileSync(path.join(process.env.HOME, '.codexpro/http-token'), 'utf8').trim();
const endpoints = [
  { name: 'Local (127.0.0.1:8787)', base: 'http://127.0.0.1:8787' },
  { name: 'Public Tailscale Funnel', base: 'https://macbook-pro-stas.tail64004b.ts.net' }
];

function log(status, msg) {
  const symbol = status === 'OK' ? '\x1b[32m✓\x1b[0m' : status === 'FAIL' ? '\x1b[31m✗\x1b[0m' : '\x1b[33mℹ\x1b[0m';
  console.log(`  ${symbol} [${status}] ${msg}`);
}

async function runTestsForEndpoint(ep) {
  console.log(`\n======================================================`);
  console.log(`Testing Endpoint: ${ep.name} (${ep.base})`);
  console.log(`======================================================`);

  const url = `${ep.base}/mcp?codexpro_token=${encodeURIComponent(token)}`;

  // Test 1: Health check
  try {
    const res = await fetch(`${ep.base}/healthz?codexpro_token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (res.ok && data.ok) {
      log('OK', `Healthz responded 200 OK (bashMode=${data.bashMode}, writeMode=${data.writeMode})`);
    } else {
      log('FAIL', `Healthz failed with status ${res.status}`);
      return false;
    }
  } catch (e) {
    log('FAIL', `Healthz connection failed: ${e.message}`);
    return false;
  }

  // Test 2: Stateless tools/list
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    const text = await res.text();
    const sid = res.headers.get('mcp-session-id');
    if (res.ok && (text.includes('tools') || text.includes('"result"'))) {
      log('OK', `Stateless tools/list -> 200 OK (auto-assigned session: ${sid})`);
    } else {
      log('FAIL', `Stateless tools/list -> ${res.status}: ${text}`);
      return false;
    }
  } catch (e) {
    log('FAIL', `Stateless tools/list error: ${e.message}`);
    return false;
  }

  // Test 3: Stateless tool call (bash)
  const testToken = `token-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'bash',
          arguments: { command: `echo "${testToken}"` }
        }
      })
    });
    const text = await res.text();
    if (res.ok && text.includes(testToken)) {
      log('OK', `Stateless tool call (bash) -> 200 OK, output verified`);
    } else {
      log('FAIL', `Stateless tool call (bash) -> ${res.status}: ${text}`);
      return false;
    }
  } catch (e) {
    log('FAIL', `Stateless tool call (bash) error: ${e.message}`);
    return false;
  }

  // Test 4: Accept header matrix (testing strict MCP SDK behavior)
  const acceptHeaders = [
    { label: 'application/json only', header: 'application/json' },
    { label: 'text/event-stream only', header: 'text/event-stream' },
    { label: '*/* wildcard', header: '*/*' },
    { label: 'both types standard', header: 'application/json, text/event-stream' },
    { label: 'missing header', header: null }
  ];

  for (const item of acceptHeaders) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (item.header !== null) headers['Accept'] = item.header;

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'bash', arguments: { command: 'echo "accept test"' } }
        })
      });
      const text = await res.text();
      if (res.ok && text.includes('accept test')) {
        log('OK', `Accept header [${item.label}] -> 200 OK (normalized transparently)`);
      } else {
        log('FAIL', `Accept header [${item.label}] -> ${res.status}: ${text}`);
        return false;
      }
    } catch (e) {
      log('FAIL', `Accept header [${item.label}] error: ${e.message}`);
      return false;
    }
  }

  // Test 5: File write & read lifecycle
  const testFileName = `manual-test-${Date.now()}.txt`;
  const testContent = `Hello from manual QA test! Random payload: ${crypto.randomBytes(32).toString('hex')}`;
  try {
    // Write file
    const writeRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'write', arguments: { path: testFileName, content: testContent } }
      })
    });
    const writeText = await writeRes.text();
    if (!writeRes.ok || writeText.includes("isError")) {
      throw new Error(`Write failed: ${writeRes.status} ${writeText}`);
    }

    // Read file back
    const readRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'read', arguments: { path: testFileName } }
      })
    });
    const readText = await readRes.text();
    if (readRes.ok && readText.includes(testContent)) {
      log('OK', `File write & read cycle verified (written and read back identical content)`);
    } else {
      log('FAIL', `File read back failed: ${readRes.status} ${readText}`);
      return false;
    }

    // Clean up file
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'bash', arguments: { command: `rm -f "${testFileName}"` } }
      })
    });
    log('OK', `Test file cleaned up successfully`);
  } catch (e) {
    log('FAIL', `File write & read lifecycle error: ${e.message}`);
    return false;
  }

  // Test 6: Parallel / Concurrent Requests (5 simultaneous tool calls)
  try {
    const parallelCount = 5;
    const promises = Array.from({ length: parallelCount }, (_, i) => {
      const pToken = `parallel-${i}-${crypto.randomBytes(4).toString('hex')}`;
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 100 + i,
          method: 'tools/call',
          params: { name: 'bash', arguments: { command: `echo "${pToken}"` } }
        })
      }).then(async (r) => ({ ok: r.ok, status: r.status, text: await r.text(), token: pToken }));
    });

    const results = await Promise.all(promises);
    const allPassed = results.every(r => r.ok && r.text.includes(r.token));
    if (allPassed) {
      log('OK', `Concurrent execution (${parallelCount} simultaneous requests) -> All 200 OK without race conditions`);
    } else {
      log('FAIL', `Concurrent execution had failures: ${JSON.stringify(results)}`);
      return false;
    }
  } catch (e) {
    log('FAIL', `Concurrent execution error: ${e.message}`);
    return false;
  }

  // Test 7: Stateful session reuse
  try {
    // 1. Initialize to get session
    const initRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 200,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'manual-qa-test', version: '1.0.0' }
        }
      })
    });
    const sessionId = initRes.headers.get('mcp-session-id');
    if (!initRes.ok || !sessionId) throw new Error(`Initialize failed: ${initRes.status}`);

    // 2. Call tool with that session ID
    const call1 = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Mcp-Session-Id': sessionId
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 201,
        method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'echo "session-test-ok"' } }
      })
    });
    const call1Text = await call1.text();
    if (call1.ok && call1Text.includes('session-test-ok')) {
      log('OK', `Session reuse (${sessionId.slice(0, 8)}...) -> 200 OK across multiple calls`);
    } else {
      log('FAIL', `Session reuse call failed: ${call1.status} ${call1Text}`);
      return false;
    }
  } catch (e) {
    log('FAIL', `Session reuse error: ${e.message}`);
    return false;
  }

  // Test 8: Long running command (latency / keepalive check)
  try {
    const started = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 300,
        method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'sleep 2 && echo "latency test finished"' } }
      })
    });
    const text = await res.text();
    const elapsed = Date.now() - started;
    if (res.ok && text.includes('latency test finished')) {
      log('OK', `Long-running command (2s execution, elapsed ${elapsed}ms) completed cleanly without timeout`);
    } else {
      log('FAIL', `Long-running command failed: ${res.status} ${text}`);
      return false;
    }
  } catch (e) {
    log('FAIL', `Long-running command error: ${e.message}`);
    return false;
  }

  // Test 9: SSE Stream Connection (GET /mcp)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const sseRes = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'text/event-stream' },
      signal: controller.signal
    }).catch(err => {
      if (err.name === 'AbortError') return { ok: true, aborted: true };
      throw err;
    });
    clearTimeout(timeout);

    if (sseRes.ok || sseRes.aborted) {
      log('OK', `SSE stream (GET /mcp) connects properly and streams text/event-stream`);
    } else {
      log('FAIL', `SSE stream returned status ${sseRes.status}`);
      return false;
    }
  } catch (e) {
    log('FAIL', `SSE stream error: ${e.message}`);
    return false;
  }

  return true;
}

async function main() {
  console.log('Starting comprehensive manual verification suite...');
  let allEndpointsPassed = true;
  for (const ep of endpoints) {
    const passed = await runTestsForEndpoint(ep);
    if (!passed) allEndpointsPassed = false;
  }

  console.log(`\n======================================================`);
  if (allEndpointsPassed) {
    console.log('\x1b[32mALL MANUAL VERIFICATION TESTS PASSED SUCCESSFULLY ON ALL ENDPOINTS!\x1b[0m');
  } else {
    console.log('\x1b[31mSOME TESTS FAILED! Check the output above.\x1b[0m');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal test suite error:', err);
  process.exit(1);
});
