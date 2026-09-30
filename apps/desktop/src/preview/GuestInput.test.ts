import { describe, expect, it, vi } from "vite-plus/test";
import { sendGuestCommand } from "./GuestInput.ts";

const setup = () => ({
  guest: { insertText: vi.fn().mockResolvedValue(undefined), sendInputEvent: vi.fn() },
  cdp: vi.fn().mockResolvedValue({ forwarded: true }),
});

describe("native guest input routing", () => {
  it("inserts text into the exact guest widget without targeting the host CDP keyboard", async () => {
    const { guest, cdp } = setup();
    await sendGuestCommand(guest, cdp, "Input.insertText", { text: "First background fill" });
    await sendGuestCommand(guest, cdp, "Input.dispatchKeyEvent", { type: "char", text: "remote" });
    expect(guest.insertText.mock.calls).toEqual([["First background fill"], ["remote"]]);
    expect(cdp).not.toHaveBeenCalled();
    expect(guest.sendInputEvent).not.toHaveBeenCalled();
  });

  it("keeps Enter in the guest and maps keyboard modifiers and printable character events", async () => {
    const { guest, cdp } = setup();
    await sendGuestCommand(guest, cdp, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
    });
    await sendGuestCommand(guest, cdp, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter" });
    await sendGuestCommand(guest, cdp, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "A",
      text: "A",
      modifiers: 8,
    });
    await sendGuestCommand(guest, cdp, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "ArrowLeft",
      modifiers: 2,
      autoRepeat: true,
    });
    expect(guest.sendInputEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "rawKeyDown", keyCode: "Enter", modifiers: [], skipIfUnhandled: true },
      { type: "keyUp", keyCode: "Enter", modifiers: [], skipIfUnhandled: true },
      { type: "keyDown", keyCode: "A", modifiers: ["shift"], skipIfUnhandled: true },
      { type: "char", keyCode: "A", modifiers: ["shift"], skipIfUnhandled: true },
      {
        type: "keyDown",
        keyCode: "Left",
        modifiers: ["control", "isautorepeat"],
        skipIfUnhandled: true,
      },
    ]);
    expect(cdp).not.toHaveBeenCalled();
  });

  it("preserves descendant renderer session routing and non-keyboard CDP commands", async () => {
    const { guest, cdp } = setup();
    const params = { type: "keyDown", key: "Enter" };
    expect(
      await sendGuestCommand(guest, cdp, "Input.dispatchKeyEvent", params, "child-renderer"),
    ).toEqual({ forwarded: true });
    await sendGuestCommand(guest, cdp, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 20,
      y: 40,
    });
    expect(cdp.mock.calls).toEqual([
      ["Input.dispatchKeyEvent", params, "child-renderer"],
      ["Input.dispatchMouseEvent", { type: "mousePressed", x: 20, y: 40 }],
    ]);
    expect(guest.sendInputEvent).not.toHaveBeenCalled();
    expect(guest.insertText).not.toHaveBeenCalled();
  });
});
