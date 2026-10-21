// Responses API over WebSocket mode, through the relay (server/relay.ts). One socket stays
// open for the panel's lifetime; each turn sends a `response.create` event and waits for the
// final response event. Measured 30-45% faster per task than POST /v1/responses, and steadier.
// The relay adds the API key, so the extension never holds it.
import { CONFIG } from './config';
import type { ComputerAction } from './input';

export type OutputItem =
  | { type: 'message'; id: string; content: { type: string; text?: string }[] }
  | { type: 'reasoning'; id: string; summary?: { type: string; text: string }[] }
  | { type: 'computer_call'; id: string; call_id: string; actions: ComputerAction[] }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
  | { type: string; id?: string };

export interface ResponseObject {
  id: string;
  status: string;
  output: OutputItem[];
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  usage?: { input_tokens: number; output_tokens: number };
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

class ApiError extends Error {
  constructor(readonly status: number, message?: string) {
    super(explain(status, message));
  }
}

/** The socket closed mid-turn. Responses are stored, so the turn can be resent on a new socket. */
class Dropped extends Error {}

export class ResponsesSocket {
  private ws?: WebSocket;
  private opening?: Promise<WebSocket>;

  constructor(private readonly url: string) {}

  /** Connect ahead of the first task so it doesn't pay for the handshake. */
  warm(): void {
    this.open().catch(() => {});
  }

  async create(body: object, signal?: AbortSignal): Promise<ResponseObject> {
    for (let attempt = 0; ; attempt++) {
      try {
        const ws = await this.open();
        signal?.throwIfAborted(); // stopped while connecting: don't send
        return await this.turn(ws, body, signal);
      } catch (e) {
        if (signal?.aborted) throw signal.reason;
        const retry = e instanceof Dropped ? attempt < 2 : e instanceof ApiError && RETRYABLE.has(e.status) && attempt < 3;
        if (!retry) throw e;
        await backoff(attempt, signal);
      }
    }
  }

  private open(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    this.opening ??= new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => ws.close(), 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve(ws);
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (this.ws === ws) this.ws = undefined;
        reject(new Dropped(`Can't reach the Spyne Report Helper relay at ${this.url}. Start it with pnpm dev (or pnpm relay).`));
      };
    }).finally(() => (this.opening = undefined));
    return this.opening;
  }

  private turn(ws: WebSocket, body: object, signal?: AbortSignal): Promise<ResponseObject> {
    return new Promise((resolve, reject) => {
      const finish = (settle: () => void) => {
        ws.removeEventListener('message', onMessage);
        ws.removeEventListener('close', onClose);
        signal?.removeEventListener('abort', onAbort);
        settle();
      };
      const onMessage = (m: MessageEvent) => {
        const e = JSON.parse(m.data as string);
        if (e.type === 'response.completed' || e.type === 'response.incomplete') finish(() => resolve(e.response));
        else if (e.type === 'response.failed') finish(() => reject(new Error(e.response?.error?.message ?? 'The model failed to respond.')));
        else if (e.type === 'error') finish(() => reject(new ApiError(e.status ?? 400, e.error?.message)));
      };
      const onClose = () => finish(() => reject(new Dropped(`Lost the connection to the Spyne Report Helper relay at ${this.url}.`)));
      // There is no cancel event, and a socket runs one response at a time: closing is how a Stop
      // frees the lane for the next task. The next turn reconnects.
      const onAbort = () => finish(() => (ws.close(), reject(signal!.reason)));
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
      ws.send(JSON.stringify({ type: 'response.create', ...body }));
    });
  }
}

export const openai = new ResponsesSocket(CONFIG.relayUrl);

export function explain(status: number, message?: string): string {
  if (status === 401) return `OpenAI rejected the API key. Check OPENAI_API_KEY in the relay's .env. ${message ?? ''}`.trim();
  if (status === 403) return `This key can't use that model or endpoint. ${message ?? ''}`.trim();
  if (status === 404) return `Model not found for this key. ${message ?? ''}`.trim();
  if (status === 429) return `Rate limited or out of credit. ${message ?? ''}`.trim();
  return message ?? `OpenAI returned an error (${status}).`;
}

async function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, 1000 * 2 ** attempt);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}

export function outputText(r: ResponseObject): string {
  return r.output
    .filter((o): o is Extract<OutputItem, { type: 'message' }> => o.type === 'message')
    .flatMap((m) => m.content.map((c) => c.text ?? ''))
    .join('\n')
    .trim();
}
