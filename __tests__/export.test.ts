import { describe, expect, it } from 'vitest';
import { crc32, csvField, fieldsCsv, makeZip, toCsv } from '../lib/export';

describe('CSV', () => {
  it('quotes fields that need it', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
  });

  it('writes a header from every key and leaves nulls empty', () => {
    const csv = toCsv([
      { name: 'Ana', city: 'Chicago' },
      { name: 'Bo', phone: '555', note: null },
    ]);
    expect(csv).toBe('name,city,phone,note\r\nAna,Chicago,,\r\nBo,,555,\r\n');
  });

  it('writes nested values as JSON', () => {
    expect(toCsv([{ vehicle: { make: 'Ford' } }])).toBe('vehicle\r\n"{""make"":""Ford""}"\r\n');
  });

  it('writes the plain result fields as field/value lines', () => {
    expect(fieldsCsv({ dealership: 'Roanoke Ford', unavailable: ['a', 'b'] })).toBe('field,value\r\ndealership,Roanoke Ford\r\nunavailable,a; b\r\n');
  });
});

describe('ZIP', () => {
  it('uses the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes local headers, a central directory and the end record', () => {
    const zip = makeZip([
      { name: 'a.csv', text: 'x\r\n1\r\n' },
      { name: 'b.csv', text: 'y\r\n2\r\n' },
    ]);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 8, true)).toBe(2);
    expect(view.getUint16(end + 10, true)).toBe(2);
  });
});
