// Spyne Report Helper is configured in code, not by the user. Change these values and rebuild.
// The API key lives only in the relay (server/relay.ts), never in the extension.

export type Effort = 'none' | 'low' | 'medium' | 'high';

/** Injected by wxt.config.ts: the relay's WebSocket URL. */
declare const __RELAY_URL__: string;

export const CONFIG = {
  relayUrl: __RELAY_URL__,
  model: 'gpt-6.1-sol',
  effort: 'medium' as Effort,
  maxTurns: 40,
};

export type Settings = typeof CONFIG & { confirmEachStep: boolean };
