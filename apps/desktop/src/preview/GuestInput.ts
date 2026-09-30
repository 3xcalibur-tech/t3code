/** CDP keyboard input follows Electron's embedder focus. Send root-page input
 * directly to this guest's renderer widget; child renderer sessions keep CDP. */
export async function sendGuestCommand(
  guest: Pick<Electron.WebContents, "insertText" | "sendInputEvent">,
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) {
  if (sessionId) return await send(method, params, sessionId);
  if (method === "Input.insertText") {
    if (typeof params?.text !== "string") throw new Error("Text input requires text.");
    await guest.insertText(params.text);
    return {};
  }
  if (method !== "Input.dispatchKeyEvent") return await send(method, params);
  const eventType = params?.type;
  if (eventType === "char") {
    if (typeof params?.text !== "string") throw new Error("Character input requires text.");
    await guest.insertText(params.text);
    return {};
  }
  if (eventType !== "keyDown" && eventType !== "rawKeyDown" && eventType !== "keyUp")
    throw new Error("Unsupported keyboard event type.");
  let key = typeof params?.key === "string" ? params.key : "";
  if (!key && typeof params?.code === "string") key = params.code.replace(/^(Key|Digit)/, "");
  if (!key) throw new Error("Keyboard input requires a key or code.");
  if (key.startsWith("Arrow")) key = key.slice(5);
  if (key === " ") key = "Space";
  const mask = typeof params?.modifiers === "number" ? params.modifiers : 0;
  const modifiers: NonNullable<Electron.InputEvent["modifiers"]> = (
    [
      [1, "alt"],
      [2, "control"],
      [4, "meta"],
      [8, "shift"],
    ] as const
  )
    .filter(([bit]) => mask & bit)
    .map(([, modifier]) => modifier);
  if (params?.autoRepeat) modifiers.push("isautorepeat");
  const event: Electron.KeyboardInputEvent & { skipIfUnhandled: true } = {
    type: eventType,
    keyCode: key,
    modifiers,
    skipIfUnhandled: true,
  };
  guest.sendInputEvent(event);
  if (eventType === "keyDown" && typeof params?.text === "string" && params.text) {
    guest.sendInputEvent({ ...event, type: "char", keyCode: params.text });
  }
  return {};
}
