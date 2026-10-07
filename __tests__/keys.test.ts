import { describe, expect, it } from 'vitest';
import { MOD, parseCombo, resolveKey } from '../lib/keys';
import { shotScale, shotSize, toCss } from '../lib/geometry';

describe('keys', () => {
  it('resolves named and single keys', () => {
    expect(resolveKey('enter')).toMatchObject({ key: 'Enter', keyCode: 13, text: '\r' });
    expect(resolveKey('a')).toMatchObject({ key: 'a', code: 'KeyA', keyCode: 65 });
    expect(resolveKey('7')).toMatchObject({ code: 'Digit7' });
    expect(resolveKey('F5')).toMatchObject({ keyCode: 116 });
  });

  it('parses combos in either form', () => {
    const a = parseCombo(['CTRL', 'A']);
    const b = parseCombo(['ctrl+a']);
    expect(a.modifiers).toBe(MOD.Control);
    expect(b.modifiers).toBe(MOD.Control);
    expect(a.keys.map((k) => k.key)).toEqual(['A']);
    expect(a.command).toBe('selectAll');
  });

  it('maps editing shortcuts to CDP commands', () => {
    expect(parseCombo(['cmd', 'c']).command).toBe('copy');
    expect(parseCombo(['cmd', 'shift', 'z']).command).toBe('redo');
    expect(parseCombo(['ENTER']).command).toBeUndefined();
  });
});

describe('geometry', () => {
  it('keeps small viewports at 1:1 and caps large ones', () => {
    expect(shotScale(1280, 720)).toBe(1);
    expect(shotScale(3200, 1800)).toBe(0.5);
  });
  it('sizes the screenshot from the capture, never stretching it', () => {
    // Retina: 2 device px per CSS px.
    expect(shotSize(1280, 2560, 1440)).toEqual({ scale: 1, width: 1280, height: 720 });
    // Capture shorter than the viewport (emulation): keep its shape, or clicks land 25% low.
    expect(shotSize(1280, 1280, 577)).toEqual({ scale: 1, width: 1280, height: 577 });
    // Large: capped to 1600x1000 without changing the aspect ratio.
    expect(shotSize(1920, 3840, 2400)).toEqual({ scale: 1600 / 1920, width: 1600, height: 1000 });
  });
  it('maps screenshot points back to CSS pixels', () => {
    expect(toCss(800, 500, 0.5)).toEqual({ x: 1600, y: 1000 });
  });
});
