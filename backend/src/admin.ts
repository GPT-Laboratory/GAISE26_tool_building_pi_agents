import type { IncomingMessage, ServerResponse } from 'http';
import { exec } from 'child_process';
import { listSessions, getByEmail, updateSession, getByToken } from './sessions.js';
import { killContainer, startFreshContainer } from './pool.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function requireAdminToken(req: IncomingMessage, res: ServerResponse, adminToken: string): boolean {
  const auth = req.headers['authorization'] ?? '';
  if (auth !== `Bearer ${adminToken}`) {
    json(res, 403, { error: 'Forbidden' });
    return false;
  }
  return true;
}

async function resetSession(email: string): Promise<{ error?: string }> {
  const session = getByEmail(email);
  if (!session) return { error: 'Session not found' };

  await killContainer(session.containerId);

  let containerId: string;
  let containerIp: string;
  try {
    const fresh = await startFreshContainer();
    containerId = fresh.containerId;
    containerIp = fresh.containerIp;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  updateSession(email, { containerId, containerIp });
  return {};
}

export async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  adminToken: string,
  poolSize: number
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const path = url.pathname;

  // Self-reset: authenticated by session token, not admin token
  if (path === '/admin/reset-self' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed: { email?: string; token?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    const { email, token } = parsed;
    if (!email || !token) {
      json(res, 400, { error: 'Missing email or token' });
      return true;
    }
    const session = getByToken(token);
    if (!session || session.email !== email.trim().toLowerCase()) {
      json(res, 403, { error: 'Invalid session token' });
      return true;
    }
    const result = await resetSession(email);
    if (result.error) {
      json(res, 500, { error: result.error });
    } else {
      json(res, 200, { ok: true });
    }
    return true;
  }

  // All other admin routes require admin token
  if (!path.startsWith('/admin/') && path !== '/admin') return false;

  if (!requireAdminToken(req, res, adminToken)) return true;

  // GET /admin/sessions
  if (path === '/admin/sessions' && req.method === 'GET') {
    const sessions = listSessions().map(s => ({
      email: s.email,
      containerId: s.containerId.slice(0, 12),
      containerIp: s.containerIp,
      createdAt: new Date(s.createdAt).toISOString(),
      lastSeen: new Date(s.lastSeen).toISOString(),
    }));
    json(res, 200, { sessions, count: sessions.length });
    return true;
  }

  // POST /admin/reset/:email
  const resetMatch = path.match(/^\/admin\/reset\/(.+)$/);
  if (resetMatch && req.method === 'POST') {
    const email = decodeURIComponent(resetMatch[1]);
    const result = await resetSession(email);
    if (result.error) {
      json(res, 404, { error: result.error });
    } else {
      json(res, 200, { ok: true, email });
    }
    return true;
  }

  // GET /admin/tail/:email
  const tailMatch = path.match(/^\/admin\/tail\/(.+)$/);
  if (tailMatch && req.method === 'GET') {
    const email = decodeURIComponent(tailMatch[1]);
    const session = getByEmail(email);
    if (!session) {
      json(res, 404, { error: 'Session not found' });
      return true;
    }
    const cmd = `docker exec ${session.containerId} tail -n 100 /home/agent/work/.activity.log 2>/dev/null || echo "(no activity log yet)"`;
    exec(cmd, (err, stdout, stderr) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(stdout || stderr || '(empty)');
    });
    return true;
  }

  // POST /admin/warm
  if (path === '/admin/warm' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let count = poolSize;
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.count === 'number') count = parsed.count;
    } catch { /* use default */ }

    // Fire and forget — respond immediately
    const { warm } = await import('./pool.js');
    warm(count).catch(err => console.error('[admin] warm error:', err));
    json(res, 202, { ok: true, warming: count });
    return true;
  }

  return false;
}
