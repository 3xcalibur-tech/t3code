import type {
  DesktopPreviewForwardedShortcut,
  DesktopPreviewShortcutEvent,
} from "@t3tools/contracts";

/** Physical punctuation and digit keys, matching the app's shortcut matcher. */
const CODE_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

type ShortcutInput = Pick<
  Electron.Input,
  "type" | "key" | "code" | "meta" | "control" | "shift" | "alt" | "isAutoRepeat"
>;

/**
 * Keys a press can match: the layout key, plus the physical key when the
 * layout does not produce a Latin letter (non-Latin layouts, Option symbols).
 */
const inputKeys = (input: ShortcutInput): ReadonlySet<string> => {
  const layoutKey = input.key.toLowerCase();
  if (/^[a-z]$/.test(layoutKey)) return new Set([layoutKey]);
  const keys = new Set([layoutKey === "esc" ? "escape" : layoutKey]);
  const letter = /^Key([A-Z])$/.exec(input.code)?.[1];
  if (letter) keys.add(letter.toLowerCase());
  const physicalKey = CODE_KEYS[input.code];
  if (physicalKey) keys.add(physicalKey);
  return keys;
};

/**
 * The event to hand back to the app when a press in a focused preview page is
 * one of the app's forwarded shortcuts, or null when the page keeps the key.
 * Presses without Command or Control are typing, so they always stay with the
 * page unless they are function keys.
 */
export const forwardedShortcutEvent = (
  input: ShortcutInput,
  shortcuts: ReadonlyArray<DesktopPreviewForwardedShortcut>,
): DesktopPreviewShortcutEvent | null => {
  if (input.type !== "keyDown") return null;
  if (!input.meta && !input.control && !/^F\d{1,2}$/.test(input.key)) return null;
  const keys = inputKeys(input);
  const claimed = shortcuts.some(
    (shortcut) =>
      shortcut.metaKey === input.meta &&
      shortcut.ctrlKey === input.control &&
      shortcut.shiftKey === input.shift &&
      shortcut.altKey === input.alt &&
      keys.has(shortcut.key),
  );
  if (!claimed) return null;
  return {
    key: input.key,
    code: input.code,
    metaKey: input.meta,
    ctrlKey: input.control,
    shiftKey: input.shift,
    altKey: input.alt,
    repeat: input.isAutoRepeat,
  };
};
