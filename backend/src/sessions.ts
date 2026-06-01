import { randomUUID } from 'crypto';
import { assignContainer } from './pool.js';

export interface Session {
  sessionToken: string;
  containerId: string;
  containerIp: string;
  email: string;
  createdAt: number;
  lastSeen: number;
}

// Primary index: email → session
const byEmail = new Map<string, Session>();
// Secondary index: token → session
const byToken = new Map<string, Session>();

// Rate limiting: ip → {count, resetAt}
const rateLimits = new Map<string, { count: number; resetAt: number }>();

const RATE_LIMIT_MAX = 30;       // per IP per window; join code is the real protection
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimits.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

export async function join(
  email: string,
  code: string,
  ip: string,
  joinCode: string
): Promise<{ token: string; error?: never } | { token?: never; error: string; status: number }> {
  if (!checkRateLimit(ip)) {
    return { error: 'Too many attempts. Try again in a minute.', status: 429 };
  }

  if (code !== joinCode) {
    return { error: 'Invalid join code.', status: 401 };
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    return { error: 'Invalid email address.', status: 400 };
  }

  // Reconnect: return existing session
  const existing = byEmail.get(normalizedEmail);
  if (existing) {
    existing.lastSeen = Date.now();
    return { token: existing.sessionToken };
  }

  // New participant: assign a container
  let containerId: string;
  let containerIp: string;
  try {
    const assigned = await assignContainer();
    containerId = assigned.containerId;
    containerIp = assigned.containerIp;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg, status: 503 };
  }

  const session: Session = {
    sessionToken: randomUUID(),
    containerId,
    containerIp,
    email: normalizedEmail,
    createdAt: Date.now(),
    lastSeen: Date.now(),
  };

  byEmail.set(normalizedEmail, session);
  byToken.set(session.sessionToken, session);

  return { token: session.sessionToken };
}

export function getByToken(token: string): Session | undefined {
  const session = byToken.get(token);
  if (session) session.lastSeen = Date.now();
  return session;
}

export function getByEmail(email: string): Session | undefined {
  return byEmail.get(email.trim().toLowerCase());
}

export function updateSession(email: string, updates: Partial<Session>): void {
  const session = byEmail.get(email.trim().toLowerCase());
  if (!session) return;
  // Remove old token index if token is changing
  if (updates.sessionToken && updates.sessionToken !== session.sessionToken) {
    byToken.delete(session.sessionToken);
    byToken.set(updates.sessionToken, session);
  }
  Object.assign(session, updates);
}

export function listSessions(): Session[] {
  return Array.from(byEmail.values());
}
