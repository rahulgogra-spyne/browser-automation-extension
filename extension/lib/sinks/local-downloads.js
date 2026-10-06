// Writes a CSV file under the user's Downloads folder. The whole day's file is
// rewritten on each save (conflictAction "overwrite"), which lets an extension
// keep one growing file per day without asking for folder access.
//
// Sinks share one shape: writeCsvFile(filename, csv). An S3 sink can sit next
// to this one later and be called from the same place in background.js.
export async function writeCsvFile(filename, csv) {
  const url = `data:text/csv;charset=utf-8,${encodeURIComponent(`﻿${csv}`)}`;
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
  await waitUntilDone(id);
  // Drop the entry from Chrome's download list so it doesn't fill up with
  // one line per capture. The file itself stays.
  chrome.downloads.erase({ id }).catch(() => {});
}

function waitUntilDone(id, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      if (error) reject(error);
      else resolve();
    };
    const check = (state, reason) => {
      if (state === 'complete') finish();
      else if (state === 'interrupted') finish(new Error(describeFailure(reason)));
    };
    const onChanged = (delta) => {
      if (delta.id === id && delta.state) check(delta.state.current, delta.error?.current);
    };
    const timer = setTimeout(() => finish(new Error('timed out while writing the file')), timeoutMs);
    chrome.downloads.onChanged.addListener(onChanged);
    // The download may already be finished before the listener was attached.
    chrome.downloads.search({ id }).then(([item]) => item && check(item.state, item.error));
  });
}

function describeFailure(reason = '') {
  if (/ACCESS_DENIED|FILE_FAILED|TRANSIENT/.test(reason)) {
    return 'the file is probably open in Excel. Close it and write the CSV again';
  }
  return `Chrome reported ${reason || 'an unknown error'}`;
}
