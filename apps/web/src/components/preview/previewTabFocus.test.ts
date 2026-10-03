// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vite-plus/test";

import { runPreviewTabKeepingHostFocus } from "./previewTabFocus";

const noHumanInput = () => () => {};

const mount = (tag: string) => {
  const element = document.createElement(tag);
  element.tabIndex = 0;
  document.body.append(element);
  return element;
};

afterEach(() => document.body.replaceChildren());

describe("runPreviewTabKeepingHostFocus", () => {
  it("preserves the composer when guest traversal reaches a host toolbar button", async () => {
    const composer = mount("textarea");
    const toolbar = mount("button");
    composer.focus();

    const result = await runPreviewTabKeepingHostFocus(async () => {
      toolbar.focus();
      // Restore during the operation, before another keystroke can go astray.
      expect(document.activeElement).toBe(composer);
      return "pressed";
    }, noHumanInput);

    expect(result).toBe("pressed");
    expect(document.activeElement).toBe(composer);
    toolbar.focus();
    expect(document.activeElement).toBe(toolbar);
  });

  it.each(["pointerdown", "keydown"])("respects human navigation after %s", async (event) => {
    const composer = mount("textarea");
    const other = mount("input");
    composer.focus();

    await runPreviewTabKeepingHostFocus(async () => {
      other.dispatchEvent(new Event(event, { bubbles: true }));
      other.focus();
    }, noHumanInput);

    expect(document.activeElement).toBe(other);
  });

  it("respects human input in the preview while a key is pending", async () => {
    const composer = mount("textarea");
    const preview = mount("webview");
    const other = mount("button");
    composer.focus();

    let humanInput = () => {};
    await runPreviewTabKeepingHostFocus(
      async () => {
        humanInput();
        preview.focus();
        expect(document.activeElement).toBe(preview);
        other.focus();
      },
      (relinquish) => {
        humanInput = relinquish;
        return () => {};
      },
    );

    expect(document.activeElement).toBe(other);
  });

  it("leaves a removed composer alone", async () => {
    const composer = mount("textarea");
    const other = mount("button");
    composer.focus();

    await runPreviewTabKeepingHostFocus(async () => {
      composer.remove();
      other.focus();
    }, noHumanInput);

    expect(document.activeElement).toBe(other);
  });

  it("removes the guard when the key operation fails", async () => {
    const composer = mount("textarea");
    const other = mount("button");
    composer.focus();

    await expect(
      runPreviewTabKeepingHostFocus(async () => {
        throw new Error("interrupted");
      }, noHumanInput),
    ).rejects.toThrow("interrupted");
    other.focus();

    expect(document.activeElement).toBe(other);
  });

  it("preserves focus when traversal into another guest arrives after the key receipt", async () => {
    const composer = mount("textarea");
    const otherGuest = mount("webview");
    composer.focus();

    await runPreviewTabKeepingHostFocus(async () => {
      composer.blur();
      expect(document.activeElement).toBe(composer);
    }, noHumanInput);

    otherGuest.addEventListener("focus", () => {
      otherGuest.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    otherGuest.focus();
    expect(document.activeElement).toBe(composer);
    // The pending transition is consumed; the guard no longer owns focus.
    otherGuest.focus();
    expect(document.activeElement).toBe(otherGuest);
  });

  it("releases a pending traversal when its original element is removed", async () => {
    const composer = mount("textarea");
    const other = mount("button");
    composer.focus();
    let subscribed = true;

    await runPreviewTabKeepingHostFocus(
      async () => composer.blur(),
      () => () => {
        subscribed = false;
      },
    );
    expect(subscribed).toBe(true);
    composer.remove();
    other.focus();

    expect(document.activeElement).toBe(other);
    expect(subscribed).toBe(false);
  });

  it.each(["pointerdown", "keydown"])(
    "relinquishes a late traversal when the human sends %s after the key receipt",
    async (event) => {
      const composer = mount("textarea");
      const other = mount("button");
      composer.focus();

      await runPreviewTabKeepingHostFocus(async () => composer.blur(), noHumanInput);
      other.dispatchEvent(new Event(event, { bubbles: true }));
      other.focus();

      expect(document.activeElement).toBe(other);
    },
  );
});
