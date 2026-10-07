import { Fragment, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { runAgent, type LogEntry } from '@/lib/agent';
import { CONFIG } from '@/lib/config';
import { DEFAULT_DMS, FLOWS, type DmsId, type Flow } from '@/lib/flows';
import { openai } from '@/lib/openai';
import { mark, release, type Presence } from '@/lib/presence';
import { PANEL_PORT, type FlowEvent, type FlowState, type FromPanel, type TabInfo, type ToPanel } from '@/lib/protocol';

/** Injected by wxt.config.ts: mocked tests start runs from the front end, so each DMS's start page is a fixture. */
declare const __E2E_START_URLS__: Partial<Record<string, string>>;

type Status = 'idle' | 'running' | 'handoff';
type Mode = 'ready' | 'working' | 'handoff' | 'done' | 'stopped' | 'error';

interface Handoff {
  message: string;
  done: () => void;
}

interface Outcome {
  data?: Record<string, unknown>;
  text?: string;
  error?: string;
  stopped?: string;
}

interface Step {
  entry: LogEntry;
  at: number;
}

interface TabRow extends TabInfo {
  closed?: boolean;
}

export function App() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [tabs, setTabs] = useState<TabRow[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [clock, setClock] = useState({ start: 0, end: 0 });
  const [now, setNow] = useState(Date.now());
  const [tokens, setTokens] = useState({ input: 0, output: 0 });
  /** The screenshot open full size, as an index into this run's screenshots. */
  const [zoom, setZoom] = useState<number | null>(null);
  /** Which DMS's flow runs: set by the FE's Start (the customer's DMS), or picked here for a manual run. */
  const [dms, setDms] = useState<DmsId>(DEFAULT_DMS);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const currentRef = useRef<number | null>(null);
  const presenceRef = useRef<Presence>('working');
  const tabIds = useRef(new Set<number>());

  // The background relays our events to the product's front end and its commands to us. Refs keep
  // the port handlers (set up once) pointed at the current render's functions and state.
  const actions = useRef({ start, stop, cont: () => {} });
  actions.current = { start, stop, cont: () => handoff?.done() };
  const last = useRef<{ state: FlowState; tabId: number | null; dms?: string }>({ state: 'idle', tabId: null });
  /** The background's id for the run in progress: events carry it, and it's the only run we act on. */
  const runIdRef = useRef<number | null>(null);
  /** The FE tab that started the run, so a restarted background can take the run back over. */
  const ownerRef = useRef<number | undefined>(undefined);
  /** Waiting for the background to grant (or refuse) a run for our own Start button. */
  const reservation = useRef<((r: { runId?: number; error?: string }) => void) | null>(null);

  // The port can be mid-reconnect (the service worker restarted): a lost message must never break the run.
  const send = (msg: FromPanel) => {
    try {
      portRef.current?.postMessage(msg);
    } catch {
      /* reconnecting; the panel re-announces its run when it's back */
    }
  };
  const emit = (event: FlowEvent) => {
    if (event.type === 'state') Object.assign(last.current, { state: event.state, dms: event.dms });
    send({ type: 'flow.event', event, runId: runIdRef.current ?? undefined });
  };

  useEffect(() => {
    openai.warm();
    let closed = false;
    // Reconnect if the service worker restarts; the heartbeat keeps it from idling out mid-run.
    const connect = () => {
      const port = chrome.runtime.connect({ name: PANEL_PORT });
      portRef.current = port;
      port.onMessage.addListener((msg: ToPanel) => {
        if (msg.type === 'flow.start') {
          // Busy with another run: say so, or the new one would wait for nothing.
          if (runningRef.current && msg.runId !== runIdRef.current) send({ type: 'flow.decline', runId: msg.runId });
          else void actions.current.start(msg.dms, msg.runId, msg.ownerTab);
        }
        if (msg.type === 'flow.reserved') reservation.current?.({ runId: msg.runId });
        if (msg.type === 'flow.busy') reservation.current?.({ error: msg.error });
        if (msg.type === 'flow.stop') actions.current.stop();
        if (msg.type === 'flow.continue') actions.current.cont();
      });
      port.onDisconnect.addListener(() => !closed && setTimeout(connect, 300));
      // Say which window we're in (the background routes a run to its window's panel), then where we are.
      void chrome.windows.getCurrent().then((w) => {
        port.postMessage({ type: 'flow.hello', windowId: w.id! } satisfies FromPanel);
        port.postMessage({ type: 'flow.attached', tabId: last.current.tabId } satisfies FromPanel);
        // Mid-run (the background restarted): hand it our run back, or learn that another run owns the slot.
        if (runIdRef.current != null && last.current.dms) {
          port.postMessage({ type: 'flow.resume', runId: runIdRef.current, dms: last.current.dms as DmsId, state: last.current.state, ownerTab: ownerRef.current } satisfies FromPanel);
        }
      });
    };
    connect();
    const beat = setInterval(() => send({ type: 'flow.ping' }), 20_000);

    // Keep the "tabs in use" rows current: titles and icons change as pages load.
    const onUpdated = (id: number, info: { title?: string; favIconUrl?: string; url?: string }) => {
      if (tabIds.current.has(id) && (info.title || info.favIconUrl || info.url)) void track(id);
    };
    const onRemoved = (id: number) => {
      if (tabIds.current.has(id)) setTabs((rows) => rows.map((r) => (r.id === id ? { ...r, closed: true } : r)));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    return () => {
      closed = true;
      clearInterval(beat);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      portRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (status === 'idle') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [status]);

  useEffect(() => {
    // Follow the log while it runs; once the run is over, back to the top so the outcome is in view.
    // Braces matter: newer Chrome returns a Promise from scrollIntoView, which React would treat as a cleanup.
    if (outcome) mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    else bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [steps.length, handoff, outcome]);

  // A new run starts with nothing open full size.
  useEffect(() => setZoom(null), [clock.start]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (zoom != null && shots[zoom]) {
        if (e.key === 'Escape') return setZoom(null);
        // Earlier and later views, instead of scrolling the full-size image sideways.
        const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        if (step && shots[zoom + step]) {
          e.preventDefault();
          return setZoom(zoom + step);
        }
      }
      if (e.key === 'Escape' && abortRef.current) stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const push = (entry: LogEntry) => {
    setSteps((s) => [...s, { entry, at: Date.now() }]);
    if (entry.kind === 'action' || entry.kind === 'info' || entry.kind === 'blocked') emit({ type: 'log', text: entry.text });
  };

  /** Refresh a tab's row (and tell the FE if it's the one in use). */
  async function track(id: number) {
    const t = await chrome.tabs.get(id).catch(() => null);
    if (!t) return;
    const info: TabInfo = { id, title: t.title || t.url || 'New tab', url: t.url || t.pendingUrl || '', favIconUrl: t.favIconUrl };
    tabIds.current.add(id);
    setTabs((rows) => (rows.some((r) => r.id === id) ? rows.map((r) => (r.id === id ? { ...r, ...info } : r)) : [...rows, info]));
    if (id === currentRef.current) emit({ type: 'tab', tab: info });
  }

  /** The tab now in use: track it, and put it in the labelled tab group. */
  function use(id: number) {
    if (id === currentRef.current) return;
    currentRef.current = id;
    last.current.tabId = id;
    setCurrent(id);
    void track(id);
    void mark(id, presenceRef.current);
  }

  function present(state: Presence) {
    presenceRef.current = state;
    if (currentRef.current != null) void mark(currentRef.current, state);
  }

  async function start(requested?: DmsId, runId?: number, ownerTab?: number) {
    // A ref, not `status`: a Start can arrive twice (button and FE, or a resent command) before React re-renders.
    if (runningRef.current) return;
    runningRef.current = true;
    // Stoppable from the first moment: a Stop while the run is still being set up wins.
    const abort = new AbortController();
    abortRef.current = abort;
    const flow = FLOWS[requested ?? dms];
    let began = false;
    let done: Outcome = {};
    let used = { input: 0, output: 0 };
    try {
      if (runId == null) {
        // Our own Start button: the background keeps one run at a time, so ask it for one first.
        const granted = await new Promise<{ runId?: number; error?: string }>((resolve) => {
          reservation.current = resolve;
          send({ type: 'flow.reserve', dms: flow.dms });
          setTimeout(() => resolve({ error: 'VIN Flow could not reach its background service. Close and reopen this panel.' }), 5000);
        });
        reservation.current = null;
        if (granted.runId == null) {
          setOutcome({ error: granted.error });
          return;
        }
        runId = granted.runId;
      }
      runIdRef.current = runId;
      ownerRef.current = ownerTab;
      began = true;
      setSteps([]);
      setOutcome(null);
      setTabs([]);
      tabIds.current.clear();
      currentRef.current = null;
      setCurrent(null);
      setTokens({ input: 0, output: 0 });
      setClock({ start: Date.now(), end: 0 });
      setNow(Date.now());
      setStatus('running');
      emit({ type: 'state', state: 'running', dms: flow.dms });
      presenceRef.current = 'working';
      setDms(flow.dms);
      await release(); // the previous run's tab group
      abort.signal.throwIfAborted();

      // Every run starts fresh in its own tab, from the flow's own start page.
      const startUrl = localStartUrl() ?? (__E2E_START_URLS__[flow.dms] || flow.startUrl);
      push({ kind: 'action', text: `Open ${startUrl}`, icon: 'navigate' });
      // A blank tab first: the agent switches on read-only protection, then opens the DMS page.
      const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
      use(tab.id!);

      const result = await runAgent({
        tabId: tab.id!,
        startUrl,
        task: flow.goal,
        settings: { ...CONFIG, confirmEachStep: false },
        result: flow.result,
        // Read only, and only what the flow allows (plus wherever this run started, e.g. a local fixture).
        readOnly: {
          allowedHosts: [...flow.allowedHosts, new URL(startUrl).hostname],
          urls: [...flow.allow.urls, startUrl],
          clicks: { source: flow.allow.clicks.source, flags: flow.allow.clicks.flags },
          readEndpoints: flow.allow.readEndpoints,
        },
        signal: abort.signal,
        log: push,
        onTab: (id) => {
          send({ type: 'flow.attached', tabId: id });
          if (id != null) use(id); // null = let go for a moment (handoff); the tab is still the one in use
        },
        confirm: async () => true,
        waitForUser: (message, cancel) =>
          new Promise<void>((resolve) => {
            const clear = () => {
              setHandoff(null);
              setStatus('running');
              emit({ type: 'state', state: 'running' });
              present('working');
            };
            setStatus('handoff');
            emit({ type: 'state', state: 'handoff' });
            emit({ type: 'handoff', message });
            present('handoff');
            setHandoff({ message, done: () => (clear(), resolve()) });
            cancel.addEventListener('abort', clear, { once: true });
          }),
      });
      used = result.tokens;
      done = { data: result.data as Record<string, unknown> | undefined, text: result.finalText, error: result.error, stopped: result.stopped };
    } catch (e) {
      const reason = abort.signal.aborted ? abort.signal.reason : e;
      done = abort.signal.aborted ? { stopped: (reason as Error)?.message ?? 'Stopped.' } : { error: (reason as Error)?.message ?? String(reason) };
    } finally {
      abortRef.current = null;
      runningRef.current = false;
      if (began) finish(done, used);
    }
  }

  /** The run is over, however it ended: show it, tell the background and the FE, free the slot. */
  function finish(done: Outcome, used: { input: number; output: number }) {
    setOutcome(done);
    setTokens(used);
    setClock((c) => ({ ...c, end: Date.now() }));
    setHandoff(null);
    setStatus('idle');
    present(done.data ? 'done' : done.stopped ? 'stopped' : 'error');
    if (done.data) emit({ type: 'result', data: done.data });
    else if (done.stopped) emit({ type: 'stopped', message: done.stopped });
    else emit({ type: 'error', message: done.error ?? 'The run ended without a result.' });
    emit({ type: 'state', state: 'idle' });
    runIdRef.current = null;
    ownerRef.current = undefined;
  }

  function stop() {
    abortRef.current?.abort(new Error('Stopped. You have control of the tab.'));
  }

  const busy = status !== 'idle';
  const mode: Mode =
    status === 'handoff'
      ? 'handoff'
      : status === 'running'
        ? 'working'
        : !outcome
          ? 'ready'
          : outcome.data
            ? 'done'
            : outcome.stopped
              ? 'stopped'
              : 'error';
  const elapsed = clock.start ? (clock.end || now) - clock.start : 0;
  const actionsTaken = steps.filter((s) => s.entry.kind === 'action').length;
  const lastStep = [...steps].reverse().find((s) => s.entry.kind === 'action' || s.entry.kind === 'info')?.entry;
  const stepText = lastStep && 'text' in lastStep ? lastStep.text : undefined;
  const currentTab = tabs.find((t) => t.id === current) ?? null;
  const shots = screenshots(steps);
  const zoomed = zoom != null && zoom < shots.length;

  const flow = FLOWS[dms];

  return (
    <div className="flex h-full flex-col" data-state={mode}>
      <header inert={zoomed} className="relative flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <FlowMark />
        <span className="font-semibold tracking-[-0.01em]">VIN Flow</span>
        {mode !== 'ready' && <span className="ml-auto truncate text-xs text-muted">{flow.title}</span>}
        {/* A thin bar under the header says, from across the room, whether it's working or waiting for you. */}
        {(mode === 'working' || mode === 'handoff') && <span className={`progress ${mode}`} aria-hidden />}
      </header>

      <main ref={mainRef} inert={zoomed} className="flex-1 overflow-y-auto">
        {mode === 'ready' ? (
          <Intro flow={flow} onPick={setDms} />
        ) : (
          // Pinned: the state (and "your turn") stays in view while the details scroll under it.
          <div className="sticky top-0 z-10 bg-bg">
            <StatusBlock mode={mode} outcome={outcome} handoff={handoff} step={stepText} elapsed={elapsed} actions={actionsTaken} tab={currentTab} tokens={tokens} />
          </div>
        )}
        {outcome?.data && <Result data={outcome.data} />}
        {tabs.length > 0 && <Tabs tabs={tabs} current={current} mode={mode} />}
        {/* Keyed on the run so each one starts with the default open/closed state. */}
        <LiveView key={`live-${clock.start}`} steps={steps} shots={shots} mode={mode} onZoom={setZoom} />
        {steps.length > 0 && <Steps key={`steps-${clock.start}`} steps={steps} start={clock.start} />}
        <div ref={bottomRef} />
      </main>

      {/* The run's one control, in the same place in every state. */}
      <footer inert={zoomed} className="shrink-0 border-t border-line p-3">
        {busy ? (
          <Button onClick={stop} kind="secondary" size="lg" className="w-full" aria-keyshortcuts="Escape">
            Stop
            <Kbd>Esc</Kbd>
          </Button>
        ) : (
          <Button onClick={() => void start()} size="lg" className="w-full">
            {outcome ? 'Run again' : 'Start'}
          </Button>
        )}
      </footer>

      {zoomed && <Lightbox steps={steps} shots={shots} index={zoom} onIndex={setZoom} onClose={() => setZoom(null)} />}
    </div>
  );
}

/** ?startUrl= points a run at a local fixture (tests, debugging). Loopback only: it can't widen a real flow's reach. */
function localStartUrl(): string | null {
  const raw = new URLSearchParams(location.search).get('startUrl');
  try {
    return raw && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(raw).hostname) ? raw : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- pieces */

function Intro({ flow, onPick }: { flow: Flow; onPick: (dms: DmsId) => void }) {
  return (
    <section className="fade-in px-4 pt-5 pb-6">
      <h1 className="text-[15px] font-semibold tracking-[-0.01em]">{flow.title}</h1>
      <p className="mt-1 text-muted">{flow.summary}</p>
      {/* Your product normally picks the DMS (the customer's); this is for manual runs. */}
      <div className="mt-4 flex items-center gap-3">
        <span id="dms-label" className="text-xs text-muted">
          DMS
        </span>
        <div className="flex rounded-md bg-surface p-0.5" role="group" aria-labelledby="dms-label">
          {Object.values(FLOWS).map((f) => (
            <button
              key={f.dms}
              onClick={() => onPick(f.dms)}
              aria-pressed={f.dms === flow.dms}
              className={`press rounded-[5px] px-2.5 py-1 text-xs font-medium ${f.dms === flow.dms ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`}
            >
              {f.dmsName}
            </button>
          ))}
        </div>
      </div>
      <h2 className="mt-6 border-t border-line pt-5 text-xs font-medium text-muted">While it runs</h2>
      <ul className="mt-2 space-y-2">
        {[
          'Its tab sits in a VIN Flow tab group.',
          `If ${flow.dmsName} asks you to sign in, it waits. It can't see what you type.`,
          'Chrome shows a "started debugging this browser" bar. Stop, Esc, or Cancel on that bar gives you control back.',
        ].map((text) => (
          <li key={text} className="flex gap-2.5">
            <span className="mt-[0.6em] size-1 shrink-0 rounded-full bg-muted" aria-hidden />
            {text}
          </li>
        ))}
      </ul>
    </section>
  );
}

const TITLE: Record<Mode, string> = { ready: '', working: 'Working', handoff: 'Your turn', done: 'Done', stopped: 'Stopped', error: "Couldn't finish" };
const DOT: Record<Mode, string> = { ready: 'bg-muted', working: 'bg-accent', handoff: 'bg-warn', done: 'bg-ok', stopped: 'bg-muted', error: 'bg-danger' };

/** What it's doing, or what you need to do. The one thing the panel must answer at a glance. */
function StatusBlock(props: {
  mode: Mode;
  outcome: Outcome | null;
  handoff: Handoff | null;
  step?: string;
  elapsed: number;
  actions: number;
  tab: TabRow | null;
  tokens: { input: number; output: number };
}) {
  const { mode, outcome, handoff, step, elapsed, actions, tab, tokens } = props;
  const found = outcome?.data ? summarize(outcome.data) : null;
  return (
    // Announces state changes; the ticking timer and the step-by-step line stay quiet.
    <section className="border-b border-line px-4 py-4" aria-live="polite">
      <div className="flex items-center gap-2">
        <Dot tone={DOT[mode]} pulse={mode === 'working' || mode === 'handoff'} />
        <h1 className={`text-[15px] font-semibold tracking-[-0.01em] ${mode === 'handoff' ? 'text-warn' : mode === 'error' ? 'text-danger' : ''}`}>{TITLE[mode]}</h1>
        {/* Token use is developer detail: a tooltip, nothing more. */}
        <span
          aria-live="off"
          className="ml-auto text-xs text-muted tabular-nums"
          title={tokens.input ? `${tokens.input.toLocaleString()} tokens in, ${tokens.output.toLocaleString()} out` : undefined}
        >
          {duration(elapsed)}
        </span>
      </div>
      <div className="mt-1 pl-4">
        {mode === 'working' && (
          <p aria-live="off" className="truncate text-muted">
            {step ?? 'Getting started'}
          </p>
        )}
        {mode === 'done' && <p className="text-muted">{found ? `Found ${found}.` : `Finished after ${actions} ${actions === 1 ? 'step' : 'steps'}.`}</p>}
        {mode === 'stopped' && <p className="text-muted">{stopReason(outcome?.stopped)}</p>}
        {mode === 'error' && <p className="break-words">{outcome?.error ?? (outcome?.text || 'The run ended without a result.')}</p>}
        {mode === 'handoff' && handoff && (
          <>
            <p className="mt-1.5 text-[14px] whitespace-pre-wrap">{handoff.message}</p>
            <p className="mt-1.5 text-xs text-muted">VIN Flow has let go of the tab and can't see what you type. It continues by itself once you're through, or press Continue.</p>
            <div className="mt-3.5 flex gap-2">
              {tab && <Button onClick={() => void focusTab(tab.id)}>Go to tab</Button>}
              <Button kind={tab ? 'secondary' : 'primary'} onClick={handoff.done}>
                Continue
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/** "Stopped. You have control of the tab." under a "Stopped" heading reads as the rest of the sentence. */
function stopReason(text?: string): string {
  return text?.replace(/^Stopped[.:]?\s*/, '') || 'You have control of the tab.';
}

function Tabs({ tabs, current, mode }: { tabs: TabRow[]; current: number | null; mode: Mode }) {
  const role = (t: TabRow): [string, string] => {
    if (t.closed) return ['Closed', 'text-muted'];
    if (t.id !== current) return ['Visited', 'text-muted'];
    if (mode === 'working') return ['In use', 'text-accent'];
    if (mode === 'handoff') return ['Waiting for you', 'text-warn'];
    if (mode === 'done') return ['Done', 'text-ok'];
    return ['Released', 'text-muted'];
  };
  return (
    <section className="border-b border-line px-4 pt-3 pb-2">
      <SectionLabel>{tabs.length > 1 ? 'Tabs' : 'Tab'}</SectionLabel>
      <ul className="-mx-2 mt-1">
        {tabs.map((t) => {
          const [label, tone] = role(t);
          return (
            <li key={t.id}>
              <button
                onClick={() => void focusTab(t.id)}
                disabled={t.closed}
                className="press flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-surface disabled:opacity-50"
                title="Show this tab"
              >
                <Favicon src={t.favIconUrl} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{t.title}</span>
                  <span className="block truncate text-xs text-muted">{host(t.url)}</span>
                </span>
                <span className={`shrink-0 text-xs font-medium ${tone}`}>{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type Shot = Extract<LogEntry, { kind: 'screenshot' }> & { i: number };

/** This run's screenshots, each with its place in the step list. */
function screenshots(steps: Step[]): Shot[] {
  return steps.flatMap((s, i) => (s.entry.kind === 'screenshot' ? [{ ...s.entry, i }] : []));
}

/** Where it acted on screenshot `n`: the actions between it and the next one. */
function pointsOn(steps: Step[], shots: Shot[], n: number) {
  return steps.slice(shots[n]!.i + 1, shots[n + 1]?.i ?? steps.length).flatMap((s) => (s.entry.kind === 'action' && s.entry.point ? [s.entry.point] : []));
}

/**
 * The latest screenshot with numbered markers where it acted since. Between steps (no actions yet
 * on this view) the previous step's markers stay, faded, so you can see where it last clicked.
 * Open while it works, folded away otherwise. Earlier views are a click away, full size.
 */
function LiveView({ steps, shots, mode, onZoom }: { steps: Step[]; shots: Shot[]; mode: Mode; onZoom: (n: number) => void }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const latest = shots.at(-1);
  if (!latest) return null;
  const shown = open ?? mode === 'working';
  let points = pointsOn(steps, shots, shots.length - 1);
  const faded = !points.length && shots.length > 1;
  if (faded) points = pointsOn(steps, shots, shots.length - 2);
  return (
    <Disclosure title={mode === 'working' || mode === 'handoff' ? 'Live view' : 'Last view'} open={shown} onToggle={() => setOpen(!shown)}>
      <button
        onClick={() => onZoom(shots.length - 1)}
        className="press relative block w-full cursor-zoom-in overflow-hidden rounded-md border border-line bg-surface"
        style={{ aspectRatio: `${latest.width} / ${latest.height}` }}
        aria-label="View full size"
        title="View full size"
      >
        <img src={latest.dataUrl} alt="" className="absolute inset-0 size-full object-cover" />
        <Markers points={points} shot={latest} faded={faded} />
      </button>
    </Disclosure>
  );
}

function Markers({ points, shot, faded }: { points: { x: number; y: number }[]; shot: Shot; faded?: boolean }) {
  return points.map((p, n) => (
    <span key={n} className={`marker ${faded ? 'opacity-40' : ''}`} style={{ left: `${(p.x / shot.width) * 100}%`, top: `${(p.y / shot.height) * 100}%` }} aria-hidden>
      {n + 1}
    </span>
  ));
}

/**
 * A screenshot at its real size (the panel is narrower than the page, so this is the zoom), with
 * where it acted on that view. Arrows step through the run's earlier views; Esc closes.
 */
function Lightbox({ steps, shots, index, onIndex, onClose }: { steps: Step[]; shots: Shot[]; index: number; onIndex: (n: number) => void; onClose: () => void }) {
  const shot = shots[index]!;
  const points = pointsOn(steps, shots, index);
  const scroller = useRef<HTMLDivElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => () => opener.current?.focus(), []);
  useEffect(() => {
    // Open on where it acted, or the middle of the page.
    const el = scroller.current;
    const p = points[0];
    el?.scrollTo({ left: (p?.x ?? shot.width / 2) - el.clientWidth / 2, top: p ? p.y - el.clientHeight / 2 : 0 });
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps
  const nav = 'press flex size-7 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <div role="dialog" aria-modal="true" aria-label="Screenshot, full size" className="lightbox fixed inset-0 z-50 flex flex-col bg-[oklch(0.14_0_0)] text-white">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-white/10 px-2">
        {shots.length > 1 && (
          <>
            <button className={nav} onClick={() => onIndex(index - 1)} disabled={index === 0} aria-label="Earlier view">
              <Chevron dir="left" />
            </button>
            <span className="min-w-14 text-center text-xs text-white/70 tabular-nums">
              {index + 1} of {shots.length}
            </span>
            <button className={nav} onClick={() => onIndex(index + 1)} disabled={index === shots.length - 1} aria-label="Later view">
              <Chevron dir="right" />
            </button>
          </>
        )}
        <button autoFocus onClick={onClose} className="press ml-auto flex h-7 items-center gap-2 rounded-md px-2 text-xs font-medium text-white/80 hover:bg-white/10 hover:text-white">
          Close
          <kbd className="rounded border border-white/20 px-1 font-sans text-[10px] leading-4 text-white/60" aria-hidden>
            Esc
          </kbd>
        </button>
      </div>
      <div ref={scroller} className="flex min-h-0 flex-1 overflow-auto" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="relative m-auto shrink-0" style={{ width: shot.width, height: shot.height }}>
          <img src={shot.dataUrl} alt="What VIN Flow saw" className="block size-full" />
          <Markers points={points} shot={shot} />
        </div>
      </div>
    </div>
  );
}

/** The log, folded by default: the status block already says what it's doing now. */
function Steps({ steps, start }: { steps: Step[]; start: number }) {
  const [open, setOpen] = useState(false);
  const rows = steps.filter((s) => s.entry.kind !== 'screenshot');
  return (
    <Disclosure title="Steps" meta={<span className="text-xs text-muted tabular-nums">{rows.length}</span>} open={open} onToggle={() => setOpen(!open)}>
      <ol className="space-y-1.5">
        {rows.map((s, i) => {
          const e = s.entry;
          if (e.kind === 'screenshot') return null;
          const tone =
            e.kind === 'blocked' ? 'text-warn' : e.kind === 'error' ? 'text-danger' : e.kind === 'thinking' || e.kind === 'info' || e.kind === 'task' ? 'text-muted' : '';
          return (
            <li key={`${s.at}-${i}`} className="fade-in grid grid-cols-[2.25rem_1fr] gap-2 text-xs">
              <span className="text-muted tabular-nums">{stamp(s.at - start)}</span>
              <span className={`min-w-0 break-words ${tone} ${e.kind === 'thinking' ? 'italic' : ''}`}>{e.kind === 'message' ? linkify(e.text) : e.text}</span>
            </li>
          );
        })}
      </ol>
    </Disclosure>
  );
}

function Result({ data }: { data: Record<string, unknown> }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(data, null, 2);
  const entries = Object.entries(data);
  const fields = entries.filter(([, value]) => !isRecords(value));
  const lists = entries.filter(([, value]) => isRecords(value));
  return (
    // A table ends the section flush: its last row's divider is the section's.
    <section data-testid="result" className={`fade-in border-b border-line px-4 pt-3 ${lists.length ? '' : 'pb-4'}`}>
      <div className="flex h-7 items-center">
        <SectionLabel>Result</SectionLabel>
        <div className="-mr-2 ml-auto flex">
          <Button kind="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(json).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>
            {copied ? 'Copied' : 'Copy JSON'}
          </Button>
          <Button kind="ghost" size="sm" onClick={() => download(json)}>
            Download
          </Button>
        </div>
      </div>
      {fields.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
          {fields.map(([key, value]) => (
            <Fragment key={key}>
              <dt className="text-muted">{humanize(key)}</dt>
              <dd className="min-w-0 break-words">{show(value)}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {lists.map(([key, value]) => (
        <Records key={key} name={humanize(key)} rows={value as Record<string, unknown>[]} />
      ))}
    </section>
  );
}

/** A folding section for secondary detail. */
function Disclosure({ title, meta, open, onToggle, children }: { title: string; meta?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  const id = useId();
  return (
    <section className="border-b border-line">
      <button onClick={onToggle} aria-expanded={open} aria-controls={id} className="group flex h-10 w-full items-center gap-2 px-4 text-left focus-visible:-outline-offset-2">
        <span className="text-xs font-medium text-muted group-hover:text-fg">{title}</span>
        {meta}
        <Chevron dir={open ? 'down' : 'right'} className="ml-auto text-muted group-hover:text-fg" />
      </button>
      {open && (
        <div id={id} className="px-4 pb-4">
          {children}
        </div>
      )}
    </section>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="text-xs font-medium text-muted">{children}</h2>;
}

function Dot({ tone, pulse }: { tone: string; pulse?: boolean }) {
  return <span className={`size-2 shrink-0 rounded-full ${tone} ${pulse ? 'pulse' : ''}`} aria-hidden />;
}

const TURN = { right: '', down: 'rotate-90', left: 'rotate-180' };

function Chevron({ dir, className = '' }: { dir: keyof typeof TURN; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={`size-3.5 shrink-0 transition-transform ${TURN[dir]} ${className}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

function Favicon({ src }: { src?: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken || src.startsWith('chrome://')) {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center text-muted">
        <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
        </svg>
      </span>
    );
  }
  return <img src={src} alt="" className="size-4 shrink-0 rounded-sm" onError={() => setBroken(true)} />;
}

/* ---------------------------------------------------------------- helpers */

async function focusTab(id: number) {
  const t = await chrome.tabs.update(id, { active: true }).catch(() => undefined);
  if (t?.windowId != null) await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
}

function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** m:ss, for the step log. */
function stamp(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A list of objects (e.g. repair orders) is shown as a table. */
function isRecords(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((v) => v && typeof v === 'object' && !Array.isArray(v));
}

/** "6 repair orders": the first list of records in the result, for the status line. */
function summarize(data: Record<string, unknown>): string | null {
  const list = Object.entries(data).find(([, value]) => isRecords(value));
  if (!list) return null;
  const n = (list[1] as unknown[]).length;
  const name = humanize(list[0]).toLowerCase();
  return `${n} ${n === 1 ? name.replace(/s$/, '') : name}`;
}

/**
 * Edge to edge, so the narrow panel shows as many columns as it can. The first column stays put
 * while the rest scroll sideways, and a fade on the right says there are more.
 */
function Records({ name, rows }: { name: string; rows: Record<string, unknown>[] }) {
  const columns = Object.keys(rows[0]!);
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ scrolled: false, more: false });
  const measure = () => {
    const el = scroller.current;
    if (el) setEdges({ scrolled: el.scrollLeft > 0, more: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  };
  useEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller.current!);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="mt-5">
      <h3 className="flex items-baseline gap-1.5">
        <span className="font-medium">{name}</span>
        <span className="text-xs text-muted tabular-nums">{rows.length}</span>
      </h3>
      <div className="relative -mx-4 mt-2">
        <div ref={scroller} onScroll={measure} data-scrolled={edges.scrolled || undefined} className="max-h-80 overflow-auto border-t border-line">
          <table className="records w-full border-collapse text-left text-xs">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} className="px-3 py-2 font-medium whitespace-nowrap text-muted">
                    {humanize(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c} className="px-3 py-2 align-top whitespace-nowrap">
                      {show(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {edges.more && <div className="pointer-events-none absolute top-px right-0 bottom-0 w-10 bg-linear-to-l from-bg" aria-hidden />}
      </div>
    </div>
  );
}

const ACRONYMS: Record<string, string> = { ro: 'RO', vin: 'VIN', id: 'ID', url: 'URL', dms: 'DMS' };

function humanize(key: string): string {
  const words = key.split('_').map((w) => ACRONYMS[w] ?? w);
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function show(value: unknown): ReactNode {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) {
    return <span className="text-muted">None</span>;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function download(json: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = `vin-flow-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function linkify(text: string): ReactNode[] {
  return text.split(/(https?:\/\/[^\s)]+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer" className="underline break-all">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

const KIND = {
  primary: 'bg-fg text-bg hover:opacity-85',
  secondary: 'border border-line text-fg hover:bg-surface',
  ghost: 'text-muted hover:bg-surface hover:text-fg',
};
const SIZE = { sm: 'h-7 px-2 text-xs', md: 'h-8 px-3.5', lg: 'h-9 px-4' };

function Button({ kind = 'primary', size = 'md', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: keyof typeof KIND; size?: keyof typeof SIZE }) {
  return <button {...props} className={`press inline-flex items-center justify-center gap-2 rounded-md font-medium disabled:opacity-40 ${KIND[kind]} ${SIZE[size]} ${className}`} />;
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line px-1 font-sans text-[10px] leading-4 font-normal text-muted" aria-hidden>
      {children}
    </kbd>
  );
}

/** The extension's icon, in the panel's own colours. */
function FlowMark() {
  return (
    <svg viewBox="0 0 128 128" className="size-4 shrink-0" aria-hidden>
      <rect width="128" height="128" rx="30" className="fill-fg" />
      <g fill="none" className="stroke-bg" strokeWidth="9" strokeLinecap="round">
        <circle cx="64" cy="64" r="28" />
        <circle cx="64" cy="64" r="7" className="fill-bg" stroke="none" />
        <path d="M64 20v16M64 92v16M20 64h16M92 64h16M33 33l11 11M84 84l11 11M33 95l11-11M84 44l11-11" />
      </g>
    </svg>
  );
}
