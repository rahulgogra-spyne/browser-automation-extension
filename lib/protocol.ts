// How the product's front end (FE) talks to the extension. The FE is a web page listed in
// externally_connectable (wxt.config.ts); it addresses the extension by its fixed ID.
//
//   FE -> extension, chrome.runtime.sendMessage(EXTENSION_ID, command, reply):
//     { type: 'hello' }     -> Hello              (also how the FE knows the extension is installed,
//                                                  and which DMSs it supports)
//     { type: 'start', dms } -> { ok, error? }     dms: the DMS the customer uses (Hello.flows[].dms).
//                                                  Call it straight from a click handler: Chrome only
//                                                  lets the extension open its side panel for a click
//     { type: 'stop' }      -> { ok }              } only from the FE tab that started the run
//     { type: 'continue' }  -> { ok }              } (continue: the user is done signing in; it also
//     { type: 'focus' }     -> { ok }              }  resumes alone. focus: show the run's tab)
//
//   extension -> FE, on a port from chrome.runtime.connect(EXTENSION_ID, { name: 'vin-flow' }):
//     FlowEvent, starting with the current state as soon as the port opens.
//
// Inside the extension the side panel runs the flow; the background worker relays between it and
// every connected FE page.
import type { DmsId } from './flows';

export type FlowState = 'idle' | 'running' | 'handoff';

export type FlowEvent =
  /** `dms`: the DMS of the run in progress (absent when idle). */
  | { type: 'state'; state: FlowState; dms?: string }
  | { type: 'log'; text: string }
  /** The tab the flow is using (null once the run is over). */
  | { type: 'tab'; tab: TabInfo | null }
  | { type: 'handoff'; message: string }
  | { type: 'result'; data: Record<string, unknown> }
  | { type: 'error'; message: string }
  | { type: 'stopped'; message: string };

export type FeCommand =
  | { type: 'hello' }
  | { type: 'start'; dms: string }
  | { type: 'stop' }
  | { type: 'continue' }
  | { type: 'focus' };

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

export interface Hello {
  installed: true;
  version: string;
  /** One per supported DMS. */
  flows: { dms: string; dmsName: string; title: string; summary: string }[];
  state: FlowState;
  /** The DMS of the run in progress, if any. */
  activeDms?: string;
}

/**
 * Background <-> side panel, on the 'flow-panel' port. The background keeps one run record (id,
 * DMS, owning panel, owning FE tab); a panel runs only with a run id it was given, and events
 * carrying another id are ignored. A panel's own Start button reserves a run the same way.
 */
export type ToPanel =
  /** `ownerTab`: the FE tab that started it, so the panel can hand the run back after a background restart. */
  | { type: 'flow.start'; dms: DmsId; runId: number; ownerTab?: number }
  | { type: 'flow.reserved'; runId: number }
  | { type: 'flow.busy'; error: string }
  | { type: 'flow.stop' }
  | { type: 'flow.continue' };
export type FromPanel =
  /** First message on every connection: which window this panel is in. */
  | { type: 'flow.hello'; windowId: number }
  /** The panel's own Start button: ask for a run. */
  | { type: 'flow.reserve'; dms: DmsId }
  | { type: 'flow.attached'; tabId: number | null }
  | { type: 'flow.event'; event: FlowEvent; runId?: number }
  /** A start this panel can't take: it's busy with another run (the background lost track of it). */
  | { type: 'flow.decline'; runId: number }
  /** On reconnecting mid-run: the run this panel is still doing. The background takes it back, or stops it. */
  | { type: 'flow.resume'; runId: number; dms: DmsId; state: FlowState; ownerTab?: number }
  /** Heartbeat: Chrome stops an idle service worker after ~30s, and a dealer can take longer to sign in. */
  | { type: 'flow.ping' };

export const FE_PORT = 'vin-flow';
export const PANEL_PORT = 'flow-panel';
