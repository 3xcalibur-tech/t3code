"use client";

/**
 * Typed window-event bus for preview-panel actions. Lets the global
 * keybinding handler in `routes/_chat.tsx` reach `ChatView`'s URL-aware
 * arbitration without prop drilling or shared refs.
 */
export type PreviewAction =
  | "toggle-panel"
  | "refresh"
  | "hard-refresh"
  | "back"
  | "forward"
  | "focus-url"
  | "zoom-in"
  | "zoom-out"
  | "reset-zoom"
  | "pick-element"
  | "dev-tools"
  | "toggle-device-toolbar";

const EVENT_NAME = "t3code:preview-action";

export function dispatchPreviewAction(action: PreviewAction): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PreviewAction>(EVENT_NAME, { detail: action }));
}

export function subscribePreviewAction(listener: (action: PreviewAction) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<PreviewAction>).detail;
    if (typeof detail === "string") listener(detail);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

let pendingUrlFocusTabId: string | null = null;

/**
 * Asks the browser view to focus its address bar once `tabId` is showing.
 * A new tab is not mounted yet when it is created, so the request waits.
 */
export function requestPreviewUrlFocus(tabId: string): void {
  pendingUrlFocusTabId = tabId;
}

export function consumePreviewUrlFocus(tabId: string): boolean {
  if (pendingUrlFocusTabId !== tabId) return false;
  pendingUrlFocusTabId = null;
  return true;
}
