// Executes one computer-tool action on a tab via CDP Input.* commands.
import { Tab, sleep } from './cdp';
import { toCss } from './geometry';
import { parseCombo, type KeyDef } from './keys';

export interface Point {
  x: number;
  y: number;
}

/** GA computer tool action shapes (docs 2026-09). */
export type ComputerAction =
  | { type: 'click'; x: number; y: number; button?: string; keys?: string[] }
  | { type: 'double_click'; x: number; y: number; keys?: string[] }
  | { type: 'move'; x: number; y: number; keys?: string[] }
  | { type: 'scroll'; x: number; y: number; scroll_x?: number; scroll_y?: number; keys?: string[] }
  | { type: 'drag'; path: Point[]; keys?: string[] }
  | { type: 'keypress'; keys: string[] }
  | { type: 'type'; text: string }
  | { type: 'wait'; ms?: number }
  | { type: 'screenshot' };

const BUTTONS: Record<string, 'left' | 'right' | 'middle'> = { left: 'left', right: 'right', wheel: 'middle', middle: 'middle' };

export async function runAction(tab: Tab, a: ComputerAction, scale: number): Promise<void> {
  const mods = 'keys' in a && a.type !== 'keypress' && a.keys ? parseCombo(a.keys).modifiers : 0;
  const mouse = (type: string, p: Point, extra: Record<string, unknown> = {}) =>
    tab.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, modifiers: mods, ...extra });

  switch (a.type) {
    case 'click': {
      const p = toCss(a.x, a.y, scale);
      const button = BUTTONS[a.button ?? 'left'];
      if (!button) throw new Error(`unsupported button: ${a.button}`);
      await mouse('mouseMoved', p);
      await mouse('mousePressed', p, { button, clickCount: 1 });
      await mouse('mouseReleased', p, { button, clickCount: 1 });
      return;
    }
    case 'double_click': {
      const p = toCss(a.x, a.y, scale);
      await mouse('mouseMoved', p);
      for (const clickCount of [1, 2]) {
        await mouse('mousePressed', p, { button: 'left', clickCount });
        await mouse('mouseReleased', p, { button: 'left', clickCount });
      }
      return;
    }
    case 'move':
      await mouse('mouseMoved', toCss(a.x, a.y, scale));
      return;
    case 'scroll': {
      const p = toCss(a.x, a.y, scale);
      await mouse('mouseMoved', p);
      await mouse('mouseWheel', p, { deltaX: (a.scroll_x ?? 0) / scale, deltaY: (a.scroll_y ?? 0) / scale });
      return;
    }
    case 'drag': {
      if (!a.path || a.path.length < 2) throw new Error('drag needs at least two points');
      const pts = a.path.map((p) => toCss(p.x, p.y, scale));
      await mouse('mouseMoved', pts[0]!);
      await mouse('mousePressed', pts[0]!, { button: 'left', clickCount: 1 });
      for (const p of pts.slice(1)) {
        await mouse('mouseMoved', p, { button: 'left', buttons: 1 });
        await sleep(16);
      }
      await mouse('mouseReleased', pts.at(-1)!, { button: 'left', clickCount: 1 });
      return;
    }
    case 'keypress':
      await pressCombo(tab, a.keys);
      return;
    case 'type': {
      // insertText is IME-style input: reliable in inputs, textareas and
      // contenteditable. Newlines become real Enter presses so forms submit.
      const lines = a.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) await tab.send('Input.insertText', { text: lines[i] });
        if (i < lines.length - 1) await pressCombo(tab, ['ENTER']);
      }
      return;
    }
    case 'wait':
      await sleep(a.ms ?? 2000);
      return;
    case 'screenshot':
      return; // the loop screenshots after every batch
    default:
      throw new Error(`unknown action: ${JSON.stringify(a)}`);
  }
}

async function pressCombo(tab: Tab, keys: string[]): Promise<void> {
  const combo = parseCombo(keys);
  const key = (type: string, def: KeyDef, modifiers: number, extra: Record<string, unknown> = {}) =>
    tab.send('Input.dispatchKeyEvent', {
      type,
      modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      ...extra,
    });

  let held = 0;
  for (const m of combo.modifierKeys) {
    await key('rawKeyDown', m, held);
    held |= modBit(m.key);
  }
  for (const def of combo.keys) {
    // Text only when no Ctrl/Alt/Meta is held, otherwise "ctrl+a" types "a".
    const printable = def.text && !(combo.modifiers & ~8) ? { text: def.text, unmodifiedText: def.text } : {};
    await key(printable.text ? 'keyDown' : 'rawKeyDown', def, combo.modifiers, {
      ...printable,
      ...(combo.command ? { commands: [combo.command] } : {}),
    });
    await key('keyUp', def, combo.modifiers);
  }
  for (const m of [...combo.modifierKeys].reverse()) {
    held &= ~modBit(m.key);
    await key('keyUp', m, held);
  }
}

function modBit(key: string): number {
  return ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 } as Record<string, number>)[key] ?? 0;
}

export function describeAction(a: ComputerAction): string {
  switch (a.type) {
    case 'click':
      return `${a.button && a.button !== 'left' ? `${a.button}-click` : 'Click'} at ${a.x}, ${a.y}${a.keys?.length ? ` with ${a.keys.join('+')}` : ''}`;
    case 'double_click':
      return `Double-click at ${a.x}, ${a.y}`;
    case 'move':
      return `Move to ${a.x}, ${a.y}`;
    case 'scroll':
      return `Scroll ${a.scroll_y ?? 0}px down, ${a.scroll_x ?? 0}px right at ${a.x}, ${a.y}`;
    case 'drag':
      return `Drag through ${a.path.length} points`;
    case 'keypress':
      return `Press ${a.keys.join('+')}`;
    case 'type':
      return `Type "${a.text.length > 60 ? `${a.text.slice(0, 60)}…` : a.text}"`;
    case 'wait':
      return 'Wait';
    case 'screenshot':
      return 'Look at the screen';
  }
}
