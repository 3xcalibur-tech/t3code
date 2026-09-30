export const BROWSER_INPUT_OWNER_SELECTOR = "[data-browser-input-owner]";

export const TYPE_TO_FOCUS_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="application"]',
  BROWSER_INPUT_OWNER_SELECTOR,
].join(",");

export interface InputEventTarget {
  readonly target?: EventTarget | null;
  readonly composedPath?: () => EventTarget[];
}

export function eventPathContainsSelector(event: InputEventTarget, selector: string): boolean {
  const path = event.composedPath?.() ?? [];
  if (path.length === 0 && event.target) path.push(event.target);
  return path.some(
    (target) =>
      typeof Element !== "undefined" &&
      target instanceof Element &&
      target.closest(selector) !== null,
  );
}

/** A controlled remote page owns keys even before its React handler receives the event. */
export function browserOwnsInputEvent(event: InputEventTarget): boolean {
  return eventPathContainsSelector(event, BROWSER_INPUT_OWNER_SELECTOR);
}

export function shouldRedirectInputToComposer(
  event: InputEventTarget & { readonly defaultPrevented: boolean },
  blockingLayerOpen: boolean,
): boolean {
  return (
    !event.defaultPrevented &&
    !blockingLayerOpen &&
    !eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR) &&
    !eventPathContainsSelector(event, INTERACTIVE_SELECTOR)
  );
}
