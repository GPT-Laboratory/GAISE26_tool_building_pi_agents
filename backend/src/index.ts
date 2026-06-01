import { createServer } from 'http';
import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import WebSocket, { WebSocketServer } from 'ws';
import { join as joinSession } from './sessions.js';
import { getByToken } from './sessions.js';
import { configure, ensureNetwork, warm, destroyAll, docker } from './pool.js';
import { proxyWs } from './proxy.js';
import { handleAdmin } from './admin.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const JOIN_CODE = process.env.JOIN_CODE ?? 'workshop2026';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'change-me';
const POOL_SIZE = parseInt(process.env.POOL_SIZE ?? '40', 10);
const PI_MODEL = process.env.PI_MODEL ?? '';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
const OPENAI_KEY_FILE = process.env.OPENAI_KEY_FILE ? resolve(process.env.OPENAI_KEY_FILE) : undefined;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!PI_MODEL) {
  console.error('Error: PI_MODEL env var is required (e.g. gpt-4o, moonshotai/kimi-k2)');
  process.exit(1);
}

const FRONTEND_PATH = resolve(join(__dirname, '../../frontend/index.html'));

// ---------------------------------------------------------------------------
// Pool config
// ---------------------------------------------------------------------------
configure({
  piModel: PI_MODEL,
  openaiBaseUrl: OPENAI_BASE_URL,
  keyFile: OPENAI_KEY_FILE,
  apiKey: OPENAI_API_KEY,
});

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function json(res: import('http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const path = url.pathname;

  // Admin routes (includes /admin/reset-self)
  if (path.startsWith('/admin')) {
    const handled = await handleAdmin(req, res, ADMIN_TOKEN, POOL_SIZE);
    if (handled) return;
  }

  // POST /join
  if (path === '/join' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed: { email?: string; code?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const { email, code } = parsed;
    if (!email || !code) {
      json(res, 400, { error: 'Missing email or code' });
      return;
    }
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      ?? req.socket.remoteAddress
      ?? 'unknown';

    const result = await joinSession(email, code, ip, JOIN_CODE);
    if (result.error) {
      json(res, result.status, { error: result.error });
    } else {
      json(res, 200, { token: result.token });
    }
    return;
  }

  // POST /upload — copy a file into the session's data directory
  if (path === '/upload' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed: { token?: string; filename?: string; data?: string };
    try { parsed = JSON.parse(body); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const { token, filename, data } = parsed;
    if (!token || !filename || !data) { json(res, 400, { error: 'Missing fields' }); return; }
    const session = getByToken(token);
    if (!session) { json(res, 403, { error: 'Invalid token' }); return; }
    // Sanitise filename: strip path separators
    const safeName = filename.replace(/[/\\]/g, '_').slice(0, 200);
    const content = Buffer.from(data, 'base64');
    if (content.length > 20 * 1024 * 1024) { json(res, 413, { error: 'File too large (max 20 MB)' }); return; }
    try {
      const container = docker.getContainer(session.containerId);
      // putArchive cannot write into tmpfs mounts; use exec+stdin instead
      const exec = await container.exec({
        Cmd: ['sh', '-c', 'mkdir -p /home/agent/work/data && cat > "/home/agent/work/data/$1"', '--', safeName],
        AttachStdin: true,
        AttachStdout: false,
        AttachStderr: false,
        User: 'agent',
      });
      await new Promise<void>((resolve, reject) => {
        exec.start({ hijack: true, stdin: true }, (err: Error | null, stream: NodeJS.ReadWriteStream) => {
          if (err) { reject(err); return; }
          stream.write(content);
          stream.end();
          stream.on('end', resolve);
          stream.on('error', reject);
        });
      });
      json(res, 200, { ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[upload] error:', msg);
      json(res, 500, { error: msg });
    }
    return;
  }

  // Serve frontend
  if (path === '/' || path === '/index.html') {
    try {
      const html = readFileSync(FRONTEND_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('Frontend not found');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ---------------------------------------------------------------------------
// WebSocket upgrade (noServer pattern)
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (_protocols, _req) => 'tty',
});

// Pattern: /ws/agent/:token  or  /ws/work/:token
const WS_AGENT_RE = /^\/ws\/agent\/([^/]+)$/;
const WS_WORK_RE = /^\/ws\/work\/([^/]+)$/;

server.on('upgrade', (req, socket, head) => {
  const path = req.url ?? '';

  let token: string | null = null;
  let readOnly = false;

  const agentMatch = path.match(WS_AGENT_RE);
  const workMatch = path.match(WS_WORK_RE);

  if (agentMatch) {
    token = agentMatch[1];
    readOnly = false;
  } else if (workMatch) {
    token = workMatch[1];
    readOnly = true;
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const session = getByToken(token);
  if (!session) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    const port = readOnly ? 7682 : 7681;
    proxyWs(ws, session.containerIp, port, readOnly);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal POSIX tar archive containing a single file. */
function buildTar(filename: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512, 0);
  Buffer.from(filename.slice(0, 99)).copy(header, 0);
  Buffer.from('0000644\0').copy(header, 100);  // mode
  Buffer.from('0000000\0').copy(header, 108);  // uid
  Buffer.from('0000000\0').copy(header, 116);  // gid
  Buffer.from(content.length.toString(8).padStart(11, '0') + '\0').copy(header, 124); // size
  Buffer.from(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0').copy(header, 136); // mtime
  header[156] = 0x30;  // typeflag '0' = regular file
  Buffer.from('ustar  \0').copy(header, 257); // magic
  Buffer.from('        ').copy(header, 148);  // checksum placeholder
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ').copy(header, 148);
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(1024)]); // 1024 = end-of-archive
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  await ensureNetwork();
  await warm(POOL_SIZE);

  server.listen(PORT, () => {
    console.log(`[server] listening on http://0.0.0.0:${PORT}`);
    console.log(`[server] pool size: ${POOL_SIZE}, model: ${PI_MODEL}, base: ${OPENAI_BASE_URL}`);
  });
}

process.on('SIGTERM', async () => {
  console.log('[server] SIGTERM — destroying containers…');
  await destroyAll();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[server] SIGINT — destroying containers…');
  await destroyAll();
  process.exit(0);
});

main().catch(err => {
  console.error('[server] startup error:', err);
  process.exit(1);
});
