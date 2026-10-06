// Runs mapping jobs one at a time:
//   - "full" jobs re-map a whole CRM: on first start, when its config is
//     older than intervalHours (daily by default), or on request
//   - "remap" jobs re-map one failing page, queued by extraction failures
// Duplicate requests collapse into the queued job, and a page that was just
// re-mapped isn't re-mapped again within cooldownMinutes (so a broken page
// can't trigger a loop).
export function createJobs({ sites, store, runJob, intervalHours = 24, cooldownMinutes = 10, log = console.log }) {
  const queue = [];
  const recent = [];
  let running = null;
  let timer = null;
  let nextId = 1;

  const siteById = (id) => sites.find((s) => s.id === id);
  const sameTarget = (a, b) => a.crmId === b.crmId && a.type === b.type && (a.pageTypeId ?? null) === (b.pageTypeId ?? null);

  function enqueue(job) {
    // CRMs mapped from the extension are re-mapped by the extension (the
    // server has no sign-in for them).
    if (store.getCrm(job.crmId)?.mappedBy?.startsWith('extension')) return { queued: false, reason: 'mapped from the extension; the extension re-maps it', extension: true };
    if (!siteById(job.crmId)) return { queued: false, reason: `unknown CRM "${job.crmId}"` };
    const existing = [running, ...queue].find((j) => j && sameTarget(j, job));
    if (existing) return { queued: false, reason: 'already queued', jobId: existing.id };
    const cooldownMs = cooldownMinutes * 60_000;
    const justDone = recent.find((j) => sameTarget(j, job) && j.status === 'done' && Date.now() - Date.parse(j.finishedAt) < cooldownMs);
    if (job.type === 'remap' && justDone) return { queued: false, reason: 're-mapped moments ago', jobId: justDone.id };
    const entry = { id: nextId++, status: 'queued', queuedAt: new Date().toISOString(), ...job };
    queue.push(entry);
    log(`[mapper] queued #${entry.id} ${entry.type} ${entry.crmId} (${entry.reason})`);
    setImmediate(drain);
    return { queued: true, jobId: entry.id };
  }

  async function drain() {
    if (running || !queue.length) return;
    running = queue.shift();
    running.status = 'running';
    running.startedAt = new Date().toISOString();
    try {
      const entry = await runJob({ ...running, site: siteById(running.crmId) });
      running.status = 'done';
      running.version = entry?.version;
    } catch (error) {
      running.status = 'failed';
      running.error = error.message;
      log(`[mapper] #${running.id} failed: ${error.message}`);
    } finally {
      running.finishedAt = new Date().toISOString();
      recent.unshift(running);
      recent.length = Math.min(recent.length, 30);
      running = null;
      drain();
    }
  }

  // Queues a full re-map for every CRM whose config is missing or older than
  // intervalHours. Runs hourly, so a CRM that failed to map is retried hourly.
  function checkSchedule() {
    const maxAgeMs = intervalHours * 3_600_000;
    for (const site of sites) {
      const mappedAt = Date.parse(store.getCrm(site.id)?.mappedAt ?? '') || 0;
      if (Date.now() - mappedAt >= maxAgeMs) enqueue({ type: 'full', crmId: site.id, reason: mappedAt ? 'daily refresh' : 'first mapping' });
    }
  }

  return {
    enqueueFull: (crmId, reason = 'manual') => enqueue({ type: 'full', crmId, reason }),
    enqueueRemap: ({ crmId, pageTypeId, url, reason }) => enqueue({ type: 'remap', crmId, pageTypeId, url, reason }),
    status: () => ({ running, queued: [...queue], recent: [...recent] }),
    checkSchedule,
    startSchedule(everyMs = 3_600_000) {
      checkSchedule();
      timer = setInterval(checkSchedule, everyMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
    },
    idle: () => !running && !queue.length,
  };
}
