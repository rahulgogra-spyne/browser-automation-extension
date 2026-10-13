// The Gather information popup: captures the CRM on screen (the active tab,
// signed in) through its API and follows the run from session storage. The
// capture runs in the background: closing the popup does not stop it, and
// reopening it picks the progress up again. The files are downloaded when the
// run finishes.
const $ = (id) => document.getElementById(id);

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Something went wrong.');
  return response;
}

let crmNames = [];
let activeSite = null;
let busy = false;
let failedWriteDate = null;

function updateStart() {
  $('gather').disabled = busy || !activeSite?.ready;
}

// The tab on screen: a supported CRM, signed in, or a message saying where to go.
async function refreshSite() {
  const { site } = await send({ type: 'activeSite' }).catch(() => ({ site: null }));
  activeSite = site;
  const supported = crmNames.join(', ') || 'a supported CRM';
  if (!site?.crmId || !site.api) {
    $('site-name').textContent = site ? `${site.name} isn't a supported CRM` : 'No CRM on screen';
    $('site-text').textContent = `Go to ${supported} in this tab and sign in, then open this popup again.`;
  } else if (!site.ready) {
    $('site-name').textContent = site.name;
    $('site-text').textContent = site.signedOut
      ? `Sign in to ${site.name} in this tab, then press Gather information.`
      : `Open ${site.name} itself in this tab (signed in), then press Gather information.`;
  } else {
    $('site-name').textContent = site.name;
    $('site-text').textContent = `Signed in. Press Gather information to collect ${(site.datasets ?? []).join(' and ') || 'records'}.`;
  }
  updateStart();
}

const STATUS_TEXT = {
  done: 'Finished. The files are in your Downloads folder.',
  cancelled: 'Cancelled. What was gathered is in your Downloads folder.',
  failed: 'Stopped by an error.',
};

async function tick() {
  const { bulk } = await send({ type: 'bulkStatus' }).catch(() => ({ bulk: null }));
  busy = bulk?.status === 'running';
  $('now').hidden = !bulk;
  if (bulk) {
    const pct = typeof bulk.percent === 'number' ? bulk.percent : null;
    const counts = bulk.expected ? ` (${bulk.found ?? 0} of ${bulk.expected})` : bulk.found ? ` (${bulk.found})` : '';
    $('now-title').textContent = busy ? `Gathering ${bulk.name}… ${pct != null ? pct + '%' : ''}`.trim() : `${bulk.name}${pct != null ? ` — ${pct}%` : ''}`;
    $('now-phase').textContent = busy ? `${pct != null ? pct + '% complete' : 'Working'}${counts} · the files download when it finishes.` : [STATUS_TEXT[bulk.status], bulk.error].filter(Boolean).join(' ');
    $('cancel').hidden = !busy;
    $('clear').hidden = busy;
    if (bulk.fileError) $('now-note').textContent = bulk.fileError;
  }
  updateStart();
}

// A finished run whose files could not be written can be written again.
async function refreshWriteError() {
  const result = await send({ type: 'status' }).catch(() => null);
  failedWriteDate = result?.lastWriteError?.date ?? null;
  $('retry').hidden = !failedWriteDate;
  if (result?.lastWriteError) {
    $('now').hidden = false;
    $('now-note').textContent = result.lastWriteError.message;
  }
}

// (No confirm(): a dialog closes an extension popup.)
$('gather').addEventListener('click', () => {
  if (!activeSite?.ready) return;
  $('now-note').textContent = '';
  send({ type: 'captureCrmApi', crmId: activeSite.crmId, tabId: activeSite.tabId })
    .then(tick)
    .catch((error) => {
      $('now').hidden = false;
      $('now-note').textContent = error.message;
    });
});
$('cancel').addEventListener('click', () => send({ type: 'cancelCapture' }).catch(() => {}));
$('clear').addEventListener('click', () => send({ type: 'clearJobs' }).then(tick).catch(() => {}));
$('retry').addEventListener('click', async () => {
  try {
    await send({ type: 'writeDay', date: failedWriteDate });
    $('now-note').textContent = '';
  } catch (error) {
    $('now-note').textContent = error.message;
  }
  refreshWriteError();
});

send({ type: 'listCrms' })
  .then(({ crms }) => (crmNames = crms.filter((c) => c.api).map((c) => c.name)))
  .catch(() => {})
  .then(refreshSite);
setInterval(refreshSite, 2000);
tick();
setInterval(tick, 1000);
refreshWriteError();
