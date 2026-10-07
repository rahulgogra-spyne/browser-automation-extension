// Maps the model's key names ("CTRL", "ENTER", "a") to what CDP's
// Input.dispatchKeyEvent expects.

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

// CDP modifier bitmask.
export const MOD = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;

const MODIFIERS: Record<string, { bit: number; def: KeyDef }> = {
  ALT: { bit: MOD.Alt, def: { key: 'Alt', code: 'AltLeft', keyCode: 18 } },
  OPTION: { bit: MOD.Alt, def: { key: 'Alt', code: 'AltLeft', keyCode: 18 } },
  CTRL: { bit: MOD.Control, def: { key: 'Control', code: 'ControlLeft', keyCode: 17 } },
  CONTROL: { bit: MOD.Control, def: { key: 'Control', code: 'ControlLeft', keyCode: 17 } },
  META: { bit: MOD.Meta, def: { key: 'Meta', code: 'MetaLeft', keyCode: 91 } },
  CMD: { bit: MOD.Meta, def: { key: 'Meta', code: 'MetaLeft', keyCode: 91 } },
  COMMAND: { bit: MOD.Meta, def: { key: 'Meta', code: 'MetaLeft', keyCode: 91 } },
  SUPER: { bit: MOD.Meta, def: { key: 'Meta', code: 'MetaLeft', keyCode: 91 } },
  WIN: { bit: MOD.Meta, def: { key: 'Meta', code: 'MetaLeft', keyCode: 91 } },
  SHIFT: { bit: MOD.Shift, def: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 } },
};

const k = (key: string, code: string, keyCode: number, text?: string): KeyDef => ({ key, code, keyCode, text });

const NAMED: Record<string, KeyDef> = {
  ENTER: k('Enter', 'Enter', 13, '\r'),
  RETURN: k('Enter', 'Enter', 13, '\r'),
  TAB: k('Tab', 'Tab', 9),
  ESC: k('Escape', 'Escape', 27),
  ESCAPE: k('Escape', 'Escape', 27),
  SPACE: k(' ', 'Space', 32, ' '),
  BACKSPACE: k('Backspace', 'Backspace', 8),
  DELETE: k('Delete', 'Delete', 46),
  DEL: k('Delete', 'Delete', 46),
  INSERT: k('Insert', 'Insert', 45),
  HOME: k('Home', 'Home', 36),
  END: k('End', 'End', 35),
  PAGEUP: k('PageUp', 'PageUp', 33),
  PAGEDOWN: k('PageDown', 'PageDown', 34),
  LEFT: k('ArrowLeft', 'ArrowLeft', 37),
  ARROWLEFT: k('ArrowLeft', 'ArrowLeft', 37),
  UP: k('ArrowUp', 'ArrowUp', 38),
  ARROWUP: k('ArrowUp', 'ArrowUp', 38),
  RIGHT: k('ArrowRight', 'ArrowRight', 39),
  ARROWRIGHT: k('ArrowRight', 'ArrowRight', 39),
  DOWN: k('ArrowDown', 'ArrowDown', 40),
  ARROWDOWN: k('ArrowDown', 'ArrowDown', 40),
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = k(`F${i}`, `F${i}`, 111 + i);

export function resolveKey(name: string): KeyDef {
  const named = NAMED[name.toUpperCase()];
  if (named) return named;
  if (name.length === 1) {
    const upper = name.toUpperCase();
    if (/[a-z]/i.test(name)) return k(name, `Key${upper}`, upper.charCodeAt(0), name);
    if (/[0-9]/.test(name)) return k(name, `Digit${name}`, name.charCodeAt(0), name);
    return k(name, '', 0, name);
  }
  return k(name, name, 0);
}

export interface Combo {
  modifiers: number;
  modifierKeys: KeyDef[];
  keys: KeyDef[];
  /** Editing command for shortcuts CDP key events alone won't trigger (macOS). */
  command?: string;
}

const EDIT_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' };

/** ["CTRL", "A"] or ["ctrl+a"] -> modifiers bitmask + the non-modifier keys. */
export function parseCombo(input: string[]): Combo {
  const parts = input.flatMap((p) => (p.length > 1 && p.includes('+') ? p.split('+') : [p])).filter(Boolean);
  let modifiers = 0;
  const modifierKeys: KeyDef[] = [];
  const keys: KeyDef[] = [];
  for (const p of parts) {
    const mod = MODIFIERS[p.toUpperCase()];
    if (mod) {
      if (!(modifiers & mod.bit)) modifierKeys.push(mod.def);
      modifiers |= mod.bit;
    } else {
      keys.push(resolveKey(p));
    }
  }
  let command: string | undefined;
  const only = keys.length === 1 ? keys[0]!.key.toLowerCase() : undefined;
  if (only && modifiers & (MOD.Control | MOD.Meta)) {
    command = only === 'z' && modifiers & MOD.Shift ? 'redo' : EDIT_COMMANDS[only];
  }
  return { modifiers, modifierKeys, keys, command };
}
