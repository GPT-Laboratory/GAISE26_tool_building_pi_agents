import WebSocket from 'ws';

/**
 * Proxy a client WebSocket to a ttyd instance.
 *
 * ttyd uses a custom binary protocol:
 *   Server → Client: byte[0] = type (0x01=data, 0x02=title, 0x03=prefs); rest = payload
 *   Client → Server: byte[0] = type (0x00=stdin, 0x01=resize JSON); rest = payload
 *
 * For the read-only (work) pane, client→server messages are silently dropped.
 */
export function proxyWs(
  clientWs: WebSocket,
  containerIp: string,
  port: number,
  readOnly: boolean
): void {
  const targetUrl = `ws://${containerIp}:${port}/ws`;

  const upstream = new WebSocket(targetUrl, ['tty'], {
    headers: { origin: `http://${containerIp}` },
  });

  upstream.on('open', () => {
    // Drain any queued messages once upstream is ready
    drainQueue();
  });

  upstream.on('message', (data: WebSocket.RawData) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data as Buffer);
    }
  });

  upstream.on('error', err => {
    console.error('[proxy] upstream error:', err.message);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream error');
  });

  upstream.on('close', (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(code, reason);
    }
  });

  // Queue messages that arrive before upstream is OPEN
  const queue: WebSocket.RawData[] = [];
  let upstreamReady = false;

  function drainQueue(): void {
    upstreamReady = true;
    for (const msg of queue) {
      upstream.send(msg as Buffer);
    }
    queue.length = 0;
  }

  clientWs.on('message', (data: WebSocket.RawData) => {
    if (readOnly) return; // silently drop — work pane is view-only
    if (!upstreamReady) {
      queue.push(data);
      return;
    }
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data as Buffer);
    }
  });

  clientWs.on('error', err => {
    console.error('[proxy] client error:', err.message);
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
  });

  clientWs.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
  });
}
