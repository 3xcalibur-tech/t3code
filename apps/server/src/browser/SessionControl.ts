export class BrowserControlInterrupted extends Error {
  constructor() {
    super(
      "A human controls this browser. Return control to the agent before running browser commands.",
    );
  }
}

/** Serializes browser actions with control changes, including commands already queued. */
export class SessionControl {
  private tail: Promise<unknown> = Promise.resolve();
  private owner: string | null = null;
  private pendingOwner: string | null = null;

  get controller() {
    return this.owner;
  }

  private enqueue<A>(run: () => Promise<A>): Promise<A> {
    const result = this.tail.then(run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  take(viewerId: string) {
    if (
      (this.owner !== null && this.owner !== viewerId) ||
      (this.pendingOwner !== null && this.pendingOwner !== viewerId)
    )
      return Promise.reject(new Error("Another viewer controls this browser."));
    this.pendingOwner = viewerId;
    return this.enqueue(async () => {
      if (this.owner !== null && this.owner !== viewerId) {
        throw new Error("Another viewer controls this browser.");
      }
      this.owner = viewerId;
      if (this.pendingOwner === viewerId) this.pendingOwner = null;
    });
  }

  release(viewerId: string) {
    return this.enqueue(async () => {
      if (this.owner === viewerId) this.owner = null;
    });
  }

  agent<A>(run: () => Promise<A>) {
    return this.enqueue(async () => {
      if (this.owner !== null || this.pendingOwner !== null) throw new BrowserControlInterrupted();
      return run();
    });
  }

  human<A>(viewerId: string, run: () => Promise<A>) {
    return this.enqueue(async () => {
      if (this.owner !== viewerId)
        throw new Error("Take control before interacting with the browser.");
      return run();
    });
  }
}

/** A slow viewer retains one newest frame, never a growing frame queue. */
export class LatestBrowserFrame<A extends { readonly seq: number }> {
  private waiting: number | null = null;
  private latest: A | undefined;

  private readonly send: (frame: A) => void;

  constructor(send: (frame: A) => void) {
    this.send = send;
  }

  offer(frame: A) {
    if (this.waiting !== null) {
      this.latest = frame;
      return;
    }
    this.waiting = frame.seq;
    this.send(frame);
  }

  ack(seq: number) {
    if (this.waiting !== seq) return;
    this.waiting = null;
    if (this.latest !== undefined) {
      const frame = this.latest;
      this.latest = undefined;
      this.offer(frame);
    }
  }
}

/** Throttles updates while always delivering the last frame of a static page. */
export class BrowserFramePacer<A> {
  private latest: A | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastSent = -Infinity;
  private readonly send: (frame: A) => void;
  private readonly fps: () => number;
  constructor(send: (frame: A) => void, fps: () => number) {
    this.send = send;
    this.fps = fps;
  }

  offer(frame: A) {
    if (this.fps() <= 0) return;
    this.latest = frame;
    if (this.timer !== undefined) return;
    const delay = Math.max(0, 1000 / this.fps() - (performance.now() - this.lastSent));
    if (delay === 0) this.flush();
    // @effect-diagnostics-next-line globalTimers:off -- One disposable timer per active media viewer preserves the trailing frame.
    else this.timer = setTimeout(() => this.flush(), delay);
  }

  private flush() {
    this.timer = undefined;
    const frame = this.latest;
    this.latest = undefined;
    if (frame === undefined || this.fps() <= 0) return;
    this.lastSent = performance.now();
    this.send(frame);
  }

  close() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.latest = undefined;
  }
}
