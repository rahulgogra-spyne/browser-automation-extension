// Export helpers for the result: CSV text per dataset, and a ZIP that holds several files. No
// dependencies: the ZIP is written with the "stored" method (no compression), which every archive tool reads.

type Cell = unknown;

/** A cell as text: nothing for null, JSON for nested values, the plain text otherwise. */
export function cellText(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** RFC 4180: quote a field when it has a comma, a quote or a line break; double the quotes inside. */
export function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV for a list of records. The header is every key the records have, in the order they first appear. */
export function toCsv(rows: Record<string, unknown>[]): string {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [columns.map(csvField).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvField(cellText(r[c]))).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** CSV for the result's plain fields: one "field,value" line each. */
export function fieldsCsv(fields: Record<string, unknown>): string {
  return toCsv(Object.entries(fields).map(([field, value]) => ({ field, value: Array.isArray(value) ? value.join('; ') : value })));
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (the ZIP checksum). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP archive with the given text files (stored, not compressed). */
export function makeZip(files: { name: string; text: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.text);
    const crc = crc32(data);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0),
    ]);
    parts.push(local, name, data);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ]),
      name,
    );
    offset += local.length + name.length + data.length;
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(centralSize), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
