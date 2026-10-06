const pad = (n) => String(n).padStart(2, '0');

// The user's local calendar day, used for the daily file name: "2026-09-29".
export function localDateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ISO 8601 with the local UTC offset, so rows from different US time zones
// stay comparable once files are merged: "2026-09-29T17:52:03-05:00".
export function localTimestamp(d = new Date()) {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${localDateKey(d)}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
