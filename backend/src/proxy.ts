import WebSocket from 'ws';

/**
 * Proxy a client WebSocket to a ttyd instance.
 *
 * ttyd uses TEXT WebSocket frames with an ASCII digit type prefix:
 *   Server → Client: '0'=output data, '1'=window title, '2'=preferences JSON
 *   Client → Server: '0'=stdin, '1'=resize JSON {"columns":N,"rows":M}
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
    // ttyd requires the very first message to be a plain JSON auth/init object
    // (no type-prefix byte).  With no --credential flag the AuthToken is empty.
    // We use a safe default size; the client's queued resize will follow.
    const init = JSON.stringify({ AuthToken: '', columns: 80, rows: 24 });
    upstream.send(Buffer.from(init), { binary: true });
    drainQueue();
  });

  upstream.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data as Buffer, { binary: isBinary });
    }
  });

  upstream.on('error', err => {
    console.error('[proxy] upstream error:', err.message);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream error');
  });

  upstream.on('close', () => {
    // Don't forward the upstream close code — codes like 1006 (abnormal closure)
    // are valid to receive but illegal to send, and ws throws on them.
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1000);
  });

  // Queue messages that arrive before upstream is OPEN
  const queue: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
  let upstreamReady = false;

  function drainQueue(): void {
    upstreamReady = true;
    for (const { data, isBinary } of queue) {
      upstream.send(data as Buffer, { binary: isBinary });
    }
    queue.length = 0;
  }

  clientWs.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (readOnly) {
      // Read-only: forward resize (first byte 0x31 = '1') but drop stdin (0x30)
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (buf.length === 0 || buf[0] !== 0x31) return;
    }
    if (!upstreamReady) {
      queue.push({ data, isBinary });
      return;
    }
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data as Buffer, { binary: isBinary });
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
