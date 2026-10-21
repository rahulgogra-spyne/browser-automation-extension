// The service worker is the switchboard:
// - The toolbar button opens the side panel, which runs the flow (lib/agent.ts).
// - The product's front end (FE, an externally_connectable page) can check the extension is
//   installed, start a flow for the customer's DMS, stop it, and receive its progress and result
//   (lib/protocol.ts).
// - It keeps the one authoritative run record: id, DMS, the one panel connection that runs it, and
//   the FE tab that owns it. One run at a time; only the owner controls it and sees its details.
// - Safety net: the agent loop lives in the side panel page; if that page goes away mid-run
//   (panel closed, window closed, crash) we detach whatever tab it was driving.
import { FLOWS, flowFor, type DmsId } from '@/lib/flows';
import { FE_PORT, PANEL_PORT, type FeCommand, type FlowEvent, type FlowState, type FromPanel, type Hello, type ToPanel } from '@/lib/protocol';

/** Injected by wxt.config.ts: the same patterns as externally_connectable. */
declare const __FE_MATCHES__: string[];

interface Run {
  id: number;
  dms: DmsId;
  /** The window whose side panel runs it. */
  windowId?: number;
  /** The panel connection running it, once one has been handed the run. Only it is heard. */
  panel?: chrome.runtime.Port;
  /** The FE tab that started it (absent for a run started from the panel itself). */
  ownerTab?: number;
  state: FlowState;
  /** Started but not yet confirmed running by the panel. */
  pending: boolean;
  at: number;
  /** The tab the flow is using, for the FE's "Go to tab". */
  flowTab?: number;
}

export default defineBackground(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

  let run: Run | null = null;
  let seq = Date.now();
  const panels = new Map<chrome.runtime.Port, { windowId?: number; tabId: number | null }>();
  const fes = new Set<chrome.runtime.Port>();

  /** A pending start nobody picked up within 30s is abandoned. */
  const live = () => {
    if (run?.pending && run.at < Date.now() - 30_000) run = null;
    return run;
  };
  const panelFor = (windowId?: number) => [...panels].find(([, p]) => windowId == null || p.windowId === windowId)?.[0];
  /** Hand a pending FE start to one panel; from then on that connection, and only it, runs it. */
  const offer = (r: Run, port: chrome.runtime.Port | undefined) => {
    if (!port || r.panel) return;
    r.panel = port;
    port.postMessage({ type: 'flow.start', dms: r.dms, runId: r.id, ownerTab: r.ownerTab } satisfies ToPanel);
  };

  // Everyone hears the state (busy or not, and with which DMS); the run's details and data go only
  // to the FE tab that started it, never to other tabs of the product.
  const toFes = (event: FlowEvent) =>
    fes.forEach((p) => (event.type === 'state' || (run?.ownerTab != null && p.sender?.tab?.id === run.ownerTab)) && p.postMessage(event));
  const stateEvent = (): FlowEvent => (run ? { type: 'state', state: run.state, dms: run.dms } : { type: 'state', state: 'idle' });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_PORT) return;
    const me = { windowId: undefined as number | undefined, tabId: null as number | null };
    panels.set(port, me);
    port.onMessage.addListener((msg: FromPanel) => {
      switch (msg.type) {
        case 'flow.hello': {
          me.windowId = msg.windowId;
          // A Start may be waiting for this window's panel (it was still loading, or reconnected).
          const r = live();
          if (r?.pending && r.ownerTab != null && (r.windowId == null || r.windowId === msg.windowId)) offer(r, port);
          return;
        }
        case 'flow.reserve': {
          if (live()) return port.postMessage({ type: 'flow.busy', error: 'A run is already starting or in progress.' } satisfies ToPanel);
          run = { id: ++seq, dms: msg.dms, windowId: me.windowId, panel: port, state: 'idle', pending: true, at: Date.now() };
          return port.postMessage({ type: 'flow.reserved', runId: run.id } satisfies ToPanel);
        }
        case 'flow.attached':
          me.tabId = msg.tabId;
          return;
        case 'flow.event': {
          const r = live();
          if (!r || msg.runId !== r.id || r.panel !== port) return; // not the current run, or not its panel
          if (msg.event.type === 'state') {
            r.state = msg.event.state;
            if (r.state !== 'idle') r.pending = false;
          }
          if (msg.event.type === 'tab' && msg.event.tab) r.flowTab = msg.event.tab.id;
          toFes(msg.event.type === 'state' ? stateEvent() : msg.event);
          if (msg.event.type === 'result' && r.ownerTab != null) chrome.tabs.update(r.ownerTab, { active: true }).catch(() => {});
          if (msg.event.type === 'state' && msg.event.state === 'idle' && !r.pending) run = null; // finished
          return;
        }
        case 'flow.decline': {
          // The panel is busy with a run this background lost track of: this start can't happen.
          const r = live();
          if (!r || r.id !== msg.runId || r.panel !== port || !r.pending) return;
          toFes({ type: 'error', message: 'Spyne Report Helper is already running in that window. Try again when it finishes.' });
          run = null;
          toFes(stateEvent());
          return;
        }
        case 'flow.resume': {
          // This background restarted (or lost the record) while a panel kept running: take its run back.
          const r = live();
          if (r && r.id !== msg.runId) return port.postMessage({ type: 'flow.stop' } satisfies ToPanel); // another run owns the slot
          if (r) r.panel = port;
          else run = { id: msg.runId, dms: msg.dms, windowId: me.windowId, panel: port, ownerTab: msg.ownerTab, state: msg.state, pending: false, at: Date.now() };
          seq = Math.max(seq, msg.runId);
          toFes(stateEvent());
          return;
        }
      }
    });
    port.onDisconnect.addListener(() => {
      panels.delete(port);
      if (me.tabId != null) chrome.debugger.detach({ tabId: me.tabId }, () => void chrome.runtime.lastError);
      const r = live();
      if (!r || r.panel !== port) return;
      // Handed a start it never picked up (it reloaded): an FE start goes to the next panel in the
      // window; the panel's own reservation dies with it.
      if (r.pending) {
        if (r.ownerTab != null) r.panel = undefined;
        else run = null;
        return;
      }
      // The panel running the run is gone: the run is over.
      toFes({ type: 'stopped', message: 'The Spyne Report Helper panel was closed, so the run stopped.' });
      run = null;
      toFes(stateEvent());
    });
  });

  chrome.runtime.onConnectExternal.addListener((port) => {
    if (port.name !== FE_PORT) return;
    fes.add(port);
    port.postMessage(stateEvent());
    port.onDisconnect.addListener(() => fes.delete(port));
  });

  chrome.runtime.onMessageExternal.addListener((msg: FeCommand, sender, reply) => {
    const owner = (r: Run | null) => r != null && r.ownerTab != null && sender.tab?.id === r.ownerTab;
    switch (msg?.type) {
      case 'hello': {
        const r = live();
        reply({
          installed: true,
          version: chrome.runtime.getManifest().version,
          flows: Object.values(FLOWS).map(({ dms, dmsName, title, summary }) => ({ dms, dmsName, title, summary })),
          state: r?.state ?? 'idle',
          activeDms: r?.dms,
        } satisfies Hello);
        return;
      }
      case 'start': {
        if (live()) return reply({ ok: false, error: 'A run is already starting or in progress.' });
        const flow = flowFor(msg.dms);
        if (!flow) {
          const known = Object.values(FLOWS).map((f) => f.dmsName).join(', ');
          return reply({ ok: false, error: `Spyne Report Helper doesn't support the DMS "${String(msg.dms)}" yet. Supported: ${known}.` });
        }
        // Reserved now, so a second Start is refused while this one opens the panel.
        const mine: Run = { id: ++seq, dms: flow.dms, windowId: sender.tab?.windowId, ownerTab: sender.tab?.id, state: 'idle', pending: true, at: Date.now() };
        run = mine;
        // The side panel opens beside the page that started it, and the CRM opens in its own tab (the
        // panel's run does that). Must be the first async step: Chrome allows the panel only while the
        // page's click counts as a user gesture. The panel announces itself when it loads (see flow.hello).
        chrome.sidePanel.open({ windowId: sender.tab!.windowId }).then(
          () => {
            if (run !== mine) return reply({ ok: false, error: 'Stopped before it started.' }); // a Stop won the race
            offer(mine, panelFor(mine.windowId)); // or on the panel's hello, if it's still loading
            reply({ ok: true });
          },
          (e) => {
            if (run === mine) run = null;
            reply({ ok: false, error: String(e?.message ?? e) });
          },
        );
        return true; // reply is async
      }
      case 'stop': {
        const r = live();
        if (!r || !owner(r)) return reply({ ok: false, error: 'Only the page that started the run can stop it.' });
        if (r.pending) run = null; // a Start the panel hasn't picked up yet is cancelled
        r.panel?.postMessage({ type: 'flow.stop' } satisfies ToPanel);
        return reply({ ok: true });
      }
      case 'continue': {
        const r = live();
        if (!r || !owner(r)) return reply({ ok: false, error: 'Only the page that started the run can continue it.' });
        r.panel?.postMessage({ type: 'flow.continue' } satisfies ToPanel);
        return reply({ ok: true });
      }
      case 'focus': {
        const r = live();
        if (!r || !owner(r) || r.flowTab == null) return reply({ ok: false, error: 'No run of yours has a tab to show.' });
        chrome.tabs.update(r.flowTab, { active: true }).then(
          (t) => (t?.windowId != null && chrome.windows.update(t.windowId, { focused: true }), reply({ ok: true })),
          () => reply({ ok: false, error: 'That tab is gone.' }),
        );
        return true;
      }
    }
  });

  // A page that was open before install has no chrome.runtime for us yet; reload open FE tabs so
  // the product page flips to "installed" by itself.
  chrome.runtime.onInstalled.addListener(async () => {
    for (const tab of await chrome.tabs.query({ url: __FE_MATCHES__ })) {
      if (tab.id != null) chrome.tabs.reload(tab.id).catch(() => {});
    }
  });
});
