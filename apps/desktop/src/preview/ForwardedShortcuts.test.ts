import { assert, describe, it } from "vite-plus/test";

import { forwardedShortcutEvent } from "./ForwardedShortcuts.ts";

const focusUrl = { key: "l", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
const nextTab = { key: "tab", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false };
const openDevTools = { key: "i", metaKey: true, ctrlKey: false, shiftKey: false, altKey: true };

const input = (overrides: Partial<Parameters<typeof forwardedShortcutEvent>[0]>) => ({
  type: "keyDown",
  key: "l",
  code: "KeyL",
  meta: false,
  control: false,
  shift: false,
  alt: false,
  isAutoRepeat: false,
  ...overrides,
});

describe("forwardedShortcutEvent", () => {
  it("claims forwarded chords with exactly their modifiers", () => {
    assert.deepStrictEqual(forwardedShortcutEvent(input({ meta: true }), [focusUrl]), {
      key: "l",
      code: "KeyL",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
    });
    assert.isNotNull(
      forwardedShortcutEvent(input({ key: "Tab", code: "Tab", control: true }), [nextTab]),
    );
    assert.isNull(forwardedShortcutEvent(input({ meta: true, shift: true }), [focusUrl]));
    assert.isNull(forwardedShortcutEvent(input({ meta: true, type: "keyUp" }), [focusUrl]));
  });

  it("matches Option symbols by physical key", () => {
    assert.isNotNull(
      forwardedShortcutEvent(input({ key: "ˆ", code: "KeyI", meta: true, alt: true }), [
        openDevTools,
      ]),
    );
  });

  it("leaves typing with the page", () => {
    const plainLetter = { ...focusUrl, metaKey: false };
    assert.isNull(forwardedShortcutEvent(input({}), [plainLetter]));
  });
});
