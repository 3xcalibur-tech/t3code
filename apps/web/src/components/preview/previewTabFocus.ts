/**
 * Native Tab targets the guest, but its default traversal can cross into the
 * embedder or another guest. Preserve host focus until that transition arrives;
 * human keyboard/pointer input relinquishes the guard before changing focus.
 */
export async function runPreviewTabKeepingHostFocus<A>(
  press: () => Promise<A>,
  onHumanInput: (relinquish: () => void) => () => void,
): Promise<A> {
  const previous = document.activeElement;
  if (
    !(previous instanceof HTMLElement) ||
    previous === document.body ||
    previous.localName === "webview"
  ) {
    return await press();
  }

  let released = false;
  let completed = false;
  let pendingTraversal = false;
  let unsubscribe = () => {};
  const release = () => {
    if (released) return;
    released = true;
    document.removeEventListener("pointerdown", relinquish, true);
    document.removeEventListener("keydown", relinquish, true);
    document.removeEventListener("focusout", keepHostFocus, true);
    document.removeEventListener("focus", keepHostFocus, true);
    unsubscribe();
  };
  const relinquish = (event: Event) => {
    // HostedBrowserWebview replays guest focus as a synthetic pointerdown to
    // dismiss popups. It is not evidence of a human click.
    if (
      !event.isTrusted &&
      event.target instanceof HTMLElement &&
      event.target.localName === "webview"
    )
      return;
    release();
  };
  const keepHostFocus = (event: Event) => {
    if (released) return;
    if (!previous.isConnected) {
      release();
      return;
    }
    const target = event.target;
    if (event.type === "focusout") {
      if (target !== previous || document.activeElement !== document.body) return;
      pendingTraversal = true;
      previous.focus({ preventScroll: true });
      return;
    }
    if (target instanceof HTMLElement && target === document.activeElement && target !== previous) {
      previous.focus({ preventScroll: true });
      pendingTraversal = false;
      if (completed) release();
    }
  };

  unsubscribe = onHumanInput(release);
  document.addEventListener("pointerdown", relinquish, true);
  document.addEventListener("keydown", relinquish, true);
  document.addEventListener("focusout", keepHostFocus, true);
  document.addEventListener("focus", keepHostFocus, true);
  try {
    const result = await press();
    completed = true;
    return result;
  } finally {
    // Guest-to-embedder traversal crosses renderer processes. The composer can
    // blur before the key receipt, and the destination's focus can arrive after
    // it. Keep only that pending transition guarded until it arrives or the
    // human takes over; no timer or unconditional focus restoration.
    if (!completed || !pendingTraversal || !previous.isConnected) release();
  }
}
