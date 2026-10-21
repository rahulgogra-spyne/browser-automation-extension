// Relay for the Responses API's WebSocket mode.
//
// Browsers can't put an Authorization header on a WebSocket, and OpenAI accepts no other
// credential there (subprotocol keys are refused; Chrome's declarativeNetRequest header rules
// skip WebSocket handshakes). So the extension connects here, and this process connects
// upstream with the key and pipes frames both ways. The key never reaches the extension.
// In a product this is your backend: authenticate your user, then pipe the same way.
//
// `pnpm dev` starts it in-process (wxt.config.ts). Standalone: `pnpm relay`.
import { readFileSync } from 'node:fs';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

const UPSTREAM = 'wss://api.openai.com/v1/responses';
export const RELAY_PORT = 8797; // Helm uses 8787, so both can run at once

/** OPENAI_API_KEY from the environment, else from .env next to package.json. */
export function readKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  try {
    return readFileSync(new URL('../.env', import.meta.url), 'utf8').match(/^OPENAI_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  } catch {
    return '';
  }
}

export function startRelay({ port = RELAY_PORT, key = readKey(), log = (m: string) => console.log(m) } = {}) {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    // Any web page can reach localhost; only extension pages may spend the key.
    verifyClient: ({ origin }: { origin?: string }) => !!origin?.startsWith('chrome-extension://'),
  });
  wss.on('listening', () => log(`Spyne Report Helper relay on ws://127.0.0.1:${port} -> ${UPSTREAM}${key ? '' : ' (no OPENAI_API_KEY!)'}`));
  wss.on('error', (e: NodeJS.ErrnoException) =>
    log(e.code === 'EADDRINUSE' ? `Spyne Report Helper relay: port ${port} is taken, assuming a relay is already running there.` : `Spyne Report Helper relay: ${e.message}`),
  );

  wss.on('connection', (client) => {
    const fail = (status: number, message: string) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'error', status, error: { message } }));
      client.close(1011);
    };
    if (!key) return fail(401, 'The Spyne Report Helper relay has no OPENAI_API_KEY. Put it in .env and restart it.');

    const upstream = new WebSocket(UPSTREAM, { headers: { Authorization: `Bearer ${key}` } });
    // Keep each frame's kind: OpenAI closes the socket on a binary frame, and ws hands text
    // frames over as Buffers that would go out as binary unless told otherwise.
    const pending: [RawData, boolean][] = [];
    client.on('message', (data, isBinary) =>
      upstream.readyState === WebSocket.OPEN ? upstream.send(data, { binary: isBinary }) : pending.push([data, isBinary]),
    );
    upstream.on('open', () => {
      for (const [data, isBinary] of pending) upstream.send(data, { binary: isBinary });
      pending.length = 0;
    });
    upstream.on('message', (data, isBinary) => client.send(data, { binary: isBinary }));
    upstream.on('unexpected-response', (_req, res) => fail(res.statusCode ?? 502, `OpenAI refused the connection (HTTP ${res.statusCode}).`));
    upstream.on('error', (e) => !clientGone && fail(502, `Could not reach OpenAI: ${e.message}`));
    let clientGone = false;
    upstream.on('close', (code, reason) => {
      // Only worth a log line when OpenAI hung up on its own, not after the panel left.
      if (!clientGone && code !== 1000 && code !== 1005) log(`Spyne Report Helper relay: OpenAI closed the socket (${code} ${reason})`);
      client.close();
    });
    client.on('close', () => {
      clientGone = true;
      upstream.close();
    });
  });
  return wss;
}

if (import.meta.main) startRelay();
