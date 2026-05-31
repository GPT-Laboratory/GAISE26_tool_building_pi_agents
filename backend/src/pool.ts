import Dockerode from 'dockerode';
import { readFileSync, existsSync } from 'fs';

const docker = new Dockerode();

const NETWORK_NAME = 'workshop';
const IMAGE_NAME = 'pi-workshop';
const BATCH_SIZE = 10;

interface PoolEntry {
  containerId: string;
  assigned: boolean;
}

const pool: PoolEntry[] = [];
let keyIndex = 0;
let apiKeys: string[] = [];
let networkId = '';

// Config set from index.ts at startup
let cfg = {
  piModel: '',
  openaiBaseUrl: '',
};

export function configure(opts: {
  piModel: string;
  openaiBaseUrl: string;
  /** Path to a file with one API key per line. Takes precedence over apiKey. */
  keyFile?: string;
  /** Single API key, used when keyFile is not provided. */
  apiKey?: string;
}): void {
  cfg = { piModel: opts.piModel, openaiBaseUrl: opts.openaiBaseUrl };

  if (opts.keyFile && existsSync(opts.keyFile)) {
    apiKeys = readFileSync(opts.keyFile, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    if (apiKeys.length === 0) throw new Error(`No API keys found in ${opts.keyFile}`);
    console.log(`[pool] loaded ${apiKeys.length} key(s) from ${opts.keyFile}`);
  } else if (opts.apiKey) {
    apiKeys = [opts.apiKey];
    console.log('[pool] using single API key from OPENAI_API_KEY');
  } else {
    throw new Error('No API key configured. Set OPENAI_API_KEY or OPENAI_KEY_FILE.');
  }
}

function nextKey(): string {
  const key = apiKeys[keyIndex % apiKeys.length];
  keyIndex++;
  return key;
}

export async function ensureNetwork(): Promise<void> {
  const networks = await docker.listNetworks({ filters: { name: [NETWORK_NAME] } });
  const existing = networks.find(n => n.Name === NETWORK_NAME);
  if (existing) {
    networkId = existing.Id;
    console.log(`[pool] reusing network ${NETWORK_NAME} (${networkId.slice(0, 12)})`);
    return;
  }
  const net = await docker.createNetwork({
    Name: NETWORK_NAME,
    Driver: 'bridge',
    CheckDuplicate: true,
  });
  networkId = net.id;
  console.log(`[pool] created network ${NETWORK_NAME} (${networkId.slice(0, 12)})`);
}

async function startContainer(): Promise<string> {
  const key = nextKey();
  const container = await docker.createContainer({
    Image: IMAGE_NAME,
    Env: [
      `OPENAI_BASE_URL=${cfg.openaiBaseUrl}`,
      `OPENAI_API_KEY=${key}`,
      `PI_MODEL=${cfg.piModel}`,
    ],
    HostConfig: {
      Memory: 1073741824,        // 1 GB
      NanoCpus: 500_000_000,     // 0.5 CPUs
      PidsLimit: 200,
      CapDrop: ['ALL'],
      Tmpfs: {
        '/home/agent/work': 'rw,size=268435456,mode=1777',
        '/tmp': 'rw,size=67108864',
      },
      NetworkMode: NETWORK_NAME,
      // No PortBindings — ttyd never exposed to host
    },
  });
  await container.start();
  return container.id;
}

async function getContainerIp(containerId: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const info = await docker.getContainer(containerId).inspect();
    const ip = info.NetworkSettings?.Networks?.[NETWORK_NAME]?.IPAddress;
    if (ip) return ip;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Could not resolve IP for container ${containerId.slice(0, 12)}`);
}

export async function warm(n: number): Promise<void> {
  console.log(`[pool] warming ${n} containers in batches of ${BATCH_SIZE}…`);
  let started = 0;
  while (started < n) {
    const batchSize = Math.min(BATCH_SIZE, n - started);
    const batch = await Promise.allSettled(
      Array.from({ length: batchSize }, () => startContainer())
    );
    for (const result of batch) {
      if (result.status === 'fulfilled') {
        pool.push({ containerId: result.value, assigned: false });
      } else {
        console.error('[pool] failed to start container:', result.reason);
      }
    }
    started += batchSize;
    console.log(`[pool] ${pool.length} containers ready`);
  }
}

export async function assignContainer(): Promise<{ containerId: string; containerIp: string }> {
  // Find an unassigned container that's still running
  for (const entry of pool) {
    if (entry.assigned) continue;
    try {
      const info = await docker.getContainer(entry.containerId).inspect();
      if (info.State.Running) {
        entry.assigned = true;
        const ip = await getContainerIp(entry.containerId);
        return { containerId: entry.containerId, containerIp: ip };
      }
    } catch {
      // Container gone — skip
    }
  }

  // Pool exhausted — cold start
  console.warn('[pool] pool exhausted, cold-starting container');
  const containerId = await startContainer();
  pool.push({ containerId, assigned: true });
  const containerIp = await getContainerIp(containerId);
  return { containerId, containerIp };
}

export async function killContainer(containerId: string): Promise<void> {
  try {
    const c = docker.getContainer(containerId);
    await c.stop({ t: 5 });
    await c.remove({ force: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('No such container')) {
      console.error(`[pool] error killing ${containerId.slice(0, 12)}:`, msg);
    }
  }
  const idx = pool.findIndex(e => e.containerId === containerId);
  if (idx !== -1) pool.splice(idx, 1);
}

export async function startFreshContainer(): Promise<{ containerId: string; containerIp: string }> {
  const containerId = await startContainer();
  pool.push({ containerId, assigned: true });
  const containerIp = await getContainerIp(containerId);
  return { containerId, containerIp };
}

export async function destroyAll(): Promise<void> {
  console.log('[pool] destroying all containers…');
  await Promise.allSettled(pool.map(e => killContainer(e.containerId)));
}
