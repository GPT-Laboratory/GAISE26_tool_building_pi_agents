#!/usr/bin/env node
/**
 * ttyd protocol diagnostic — two phases:
 *
 *  Phase 1: Direct connection to ttyd (bypasses the proxy entirely).
 *           Dumps every message with type, encoding, and hex.
 *           Sends resize + keystrokes both as TEXT string and as BINARY buffer
 *           to see which one ttyd accepts.
 *
 *  Phase 2: Through-proxy connection (full stack: backend → proxy → ttyd).
 *           Same message dumps, verifies the proxy doesn't corrupt frames.
 *
 * Usage:
 *   # Get the workshop container IP first:
 *   CONTAINER_IP=$(docker inspect $(docker ps -qf ancestor=pi-workshop) \
 *     --format '{{.NetworkSettings.Networks.workshop.IPAddress}}')
 *
 *   node scripts/diagnose.mjs --direct $CONTAINER_IP
 *   node scripts/diagnose.mjs --proxy  http://localhost:3000  workshop2026
 *
 * Requires: ws  (uses the copy in backend/node_modules)
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import http from 'http';

const require = createRequire(import.meta.url);
const __dir = dirname(fileURLToPath(import.meta.url));
const WebSocket = require(join(__dir, '../backend/node_modules/ws'));

const PHASE = process.argv[2];         // --direct | --proxy
const ARG1  = process.argv[3];         // container IP  |  backend URL
const ARG2  = process.argv[4];         // (unused)      |  join code

// ── helpers ────────────────────────────────────────────────────────────────

function describeMsg(data, isBinary) {
  if (isBinary) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const byte0 = buf[0];
    const rest  = buf.slice(1).toString('utf8').replace(/[^\x20-\x7e]/g, '.');
    return `BINARY  byte0=0x${byte0.toString(16).padStart(2,'0')} rest=${JSON.stringify(rest.slice(0,80))}`;
  } else {
    const str = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    const type = str[0];
    const payload = str.slice(1).replace(/[^\x20-\x7e]/g, '.').slice(0, 80);
    return `TEXT    type='${type}' payload=${JSON.stringify(payload)}`;
  }
}

function connect(url, origin, label) {
  return new Promise(resolve => {
    console.log(`\n[${label}] connecting to ${url}`);
    const ws = new WebSocket(url, ['tty'], { headers: { origin } });

    ws.on('open', () => {
      console.log(`[${label}] OPEN  subprotocol=${ws.protocol}`);
      resolve(ws);
    });
    ws.on('message', (data, isBinary) => {
      console.log(`[${label}] RECV  ${describeMsg(data, isBinary)}`);
    });
    ws.on('error', err  => console.error(`[${label}] ERROR ${err.message}`));
    ws.on('close', (code, reason) => {
      console.log(`[${label}] CLOSE code=${code} reason=${reason?.toString()}`);
    });
  });
}

function send(ws, label, description, data, opts) {
  console.log(`[${label}] SEND  ${description}`);
  ws.send(data, opts ?? {});
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Phase 1: direct ────────────────────────────────────────────────────────

async function phaseDirect(containerIp) {
  const url    = `ws://${containerIp}:7681/ws`;
  const origin = `http://${containerIp}`;
  const label  = 'DIRECT';

  const ws = await connect(url, origin, label);

  await sleep(800);

  // --- resize as TEXT string (what ttyd HTML client does) ---
  send(ws, label, 'resize TEXT string',
    '1' + JSON.stringify({ columns: 80, rows: 24 }));

  await sleep(500);

  // --- Enter as TEXT string ---
  send(ws, label, 'Enter TEXT string', '0\r');

  await sleep(500);

  // --- resize as BINARY buffer (what we were sending before) ---
  const resizePayload = Buffer.from(JSON.stringify({ columns: 80, rows: 24 }));
  const resizeBin = Buffer.alloc(1 + resizePayload.length);
  resizeBin[0] = 0x01;
  resizePayload.copy(resizeBin, 1);
  send(ws, label, 'resize BINARY buffer', resizeBin, { binary: true });

  await sleep(500);

  // --- Enter as BINARY buffer ---
  const enterBin = Buffer.from([0x00, 0x0d]);
  send(ws, label, 'Enter BINARY buffer', enterBin, { binary: true });

  await sleep(2000);

  // --- send 'ls\r' as text to see if pi/shell responds ---
  send(ws, label, '"ls\\r" TEXT string', '0ls\r');

  await sleep(3000);

  ws.close(1000);
  await sleep(500);
}

// ── Phase 2: through proxy ─────────────────────────────────────────────────

async function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function phaseProxy(backendUrl, joinCode) {
  const label = 'PROXY';

  // Join
  console.log(`\n[${label}] POST ${backendUrl}/join`);
  const { status, body } = await postJson(`${backendUrl}/join`,
    { email: 'diagnose@test.local', code: joinCode });
  console.log(`[${label}] /join → ${status}`, body);

  if (!body.token) { console.error('[PROXY] No token — check join code / pool'); return; }

  const wsBase = backendUrl.replace(/^http/, 'ws');
  const agentUrl = `${wsBase}/ws/agent/${body.token}`;
  const ws = await connect(agentUrl, backendUrl, label);

  await sleep(800);

  send(ws, label, 'resize TEXT string',
    '1' + JSON.stringify({ columns: 80, rows: 24 }));

  await sleep(500);

  send(ws, label, 'Enter TEXT string', '0\r');

  await sleep(500);

  send(ws, label, '"ls\\r" TEXT string', '0ls\r');

  await sleep(3000);

  ws.close(1000);
  await sleep(500);
}

// ── main ───────────────────────────────────────────────────────────────────

if (PHASE === '--direct') {
  if (!ARG1) {
    console.error('Usage: node scripts/diagnose.mjs --direct <container-ip>');
    console.error('  Get IP: docker inspect $(docker ps -qf ancestor=pi-workshop) --format \'{{.NetworkSettings.Networks.workshop.IPAddress}}\'');
    process.exit(1);
  }
  await phaseDirect(ARG1);

} else if (PHASE === '--proxy') {
  if (!ARG1 || !ARG2) {
    console.error('Usage: node scripts/diagnose.mjs --proxy <backend-url> <join-code>');
    console.error('  Example: node scripts/diagnose.mjs --proxy http://localhost:3000 workshop2026');
    process.exit(1);
  }
  await phaseProxy(ARG1, ARG2);

} else {
  console.error('Usage:');
  console.error('  node scripts/diagnose.mjs --direct <container-ip>');
  console.error('  node scripts/diagnose.mjs --proxy  <backend-url> <join-code>');
  process.exit(1);
}
