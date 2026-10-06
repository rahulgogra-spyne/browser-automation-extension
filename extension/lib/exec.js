// A call into a page that always comes back. chrome.scripting.executeScript
// never answers while the page shows a script dialog (alert/confirm), or
// while a frame never finishes loading; then nothing after it would ever
// run, and Cancel could not be heard. Each call is given timeoutMs (long, for
// reading a big grid: `long: true`), and ends at once when the run is cancelled.
export const EXEC_MS = 90_000;
export const EXEC_LONG_MS = 20 * 60_000;

let cancelled = () => false;
// The background says how to tell that the user cancelled the run.
export const onCancelCheck = (check) => (cancelled = check);

export function execScript(options, { long = false, timeoutMs = long ? EXEC_LONG_MS : EXEC_MS } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    const end = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      fn(value);
    };
    const watch = setInterval(() => {
      if (cancelled() && Date.now() - started > 1000) end(reject, new Error('cancelled'));
      else if (Date.now() - started > timeoutMs) end(reject, new Error('the page did not answer (a dialog is open on it, or it never finished loading)'));
    }, 500);
    chrome.scripting.executeScript(options).then(
      (value) => end(resolve, value),
      (error) => end(reject, error),
    );
  });
}
