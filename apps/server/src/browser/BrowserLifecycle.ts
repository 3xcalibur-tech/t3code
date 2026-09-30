interface PendingTab {
  readonly threadId: string;
  readonly tabId: string;
  readonly profileId: string;
  readonly controller: AbortController;
}

/** Closing a preview also cancels an open that is still installing or launching. */
export class BrowserLifecycle {
  private readonly pending = new Map<string, PendingTab>();

  start(threadId: string, tabId: string, profileId: string) {
    const id = `${threadId}\u0000${tabId}`;
    this.pending.get(id)?.controller.abort();
    const token = { threadId, tabId, profileId, controller: new AbortController() };
    this.pending.set(id, token);
    return token;
  }

  finish(token: PendingTab) {
    const id = `${token.threadId}\u0000${token.tabId}`;
    if (this.pending.get(id) === token) this.pending.delete(id);
  }

  cancel(threadId?: string, tabId?: string) {
    for (const token of this.pending.values()) {
      if (
        (threadId === undefined || token.threadId === threadId) &&
        (tabId === undefined || token.tabId === tabId)
      )
        token.controller.abort();
    }
  }

  hasPendingProfile(profileId: string) {
    return [...this.pending.values()].some(
      (token) => token.profileId === profileId && !token.controller.signal.aborted,
    );
  }
}
