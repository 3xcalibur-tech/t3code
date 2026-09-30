import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveShortcutCommand } from "../keybindings";
import { browserOwnsInputEvent, shouldRedirectInputToComposer } from "./inputOwnership";

class FocusElement extends EventTarget {
  constructor(
    readonly matches: ReadonlyArray<string> = [],
    readonly parent: FocusElement | null = null,
  ) {
    super();
  }
  closest(selector: string): FocusElement | null {
    return this.matches.some((match) => selector.split(",").includes(match))
      ? this
      : (this.parent?.closest(selector) ?? null);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("remote browser input ownership", () => {
  it("keeps typing and paste on the remote page before its bubble handler runs", () => {
    vi.stubGlobal("Element", FocusElement);
    const browser = new FocusElement(["[data-browser-input-owner]", '[role="application"]']);
    const image = new FocusElement([], browser);
    for (const target of [browser, image]) {
      const event = { target, composedPath: () => [target, browser], defaultPrevented: false };
      expect(browserOwnsInputEvent(event)).toBe(true);
      expect(shouldRedirectInputToComposer(event, false)).toBe(false);
    }
    expect(
      shouldRedirectInputToComposer({ target: new FocusElement(), defaultPrevented: false }, false),
    ).toBe(true);
  });

  it("does not execute app shortcuts while the remote page owns their keys", () => {
    vi.stubGlobal("Element", FocusElement);
    const browser = new FocusElement(["[data-browser-input-owner]"]);
    const event = {
      key: "b",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      target: browser,
    };
    const bindings = [
      {
        command: "sidebar.toggle" as const,
        shortcut: {
          key: "b",
          modKey: true,
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          shiftKey: false,
        },
      },
    ];
    expect(resolveShortcutCommand(event, bindings, { platform: "Linux" })).toBeNull();
    expect(
      resolveShortcutCommand({ ...event, target: new FocusElement() }, bindings, {
        platform: "Linux",
      }),
    ).toBe("sidebar.toggle");
  });

  it("recognizes application focus without treating a watching surface as a controlled owner", () => {
    vi.stubGlobal("Element", FocusElement);
    const application = new FocusElement(['[role="application"]']);
    expect(browserOwnsInputEvent({ target: application })).toBe(false);
    expect(
      shouldRedirectInputToComposer({ target: application, defaultPrevented: false }, false),
    ).toBe(false);
  });
});
