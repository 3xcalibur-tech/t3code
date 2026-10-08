import type { LegendListRef } from "@legendapp/list/react";
import type { MessageId, RunAttemptId, RunId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { findTextRanges } from "~/lib/assistantTextSelection";
import type { TimelineEntry } from "../../session-logic";
import { timelineMessageFolds, type MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { CitationHistoryPage } from "./useAssistantCitationTarget";

/** One find match: the nth occurrence of `query` in a message. */
export interface ThreadFindTarget {
  readonly messageId: MessageId;
  readonly occurrence: number;
  readonly query: string;
  /** Changes on every navigation, so going back to a match scrolls to it again. */
  readonly key: string;
}

const MATCH_HIGHLIGHT = "t3-thread-find";
const ACTIVE_MATCH_HIGHLIGHT = "t3-thread-find-active";
const MESSAGE_BODY_SELECTOR = "[data-user-message-body], [data-assistant-citation-source]";
const MAX_SCROLL_ATTEMPTS = 8;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const EDITABLE_SELECTOR = "input, textarea, [contenteditable=true]";

function clearHighlights() {
  if (typeof CSS === "undefined" || !CSS.highlights) return;
  CSS.highlights.delete(MATCH_HIGHLIGHT);
  CSS.highlights.delete(ACTIVE_MATCH_HIGHLIGHT);
}

/**
 * Brings a find match into view: loads older history until the message is
 * there, opens the folds that hide it, scrolls to the occurrence, and keeps
 * it highlighted while it stays the target. The server counts raw message
 * text, so when markdown renders fewer occurrences the last one stands in.
 */
export function useThreadFindTarget({
  target,
  entries,
  rows,
  listRef,
  viewport,
  loadEarlier,
  onExpandRun,
  onExpandAttempt,
  onManualNavigation,
}: {
  target: ThreadFindTarget | null;
  entries: ReadonlyArray<TimelineEntry>;
  rows: ReadonlyArray<MessagesTimelineRow>;
  listRef: RefObject<LegendListRef | null>;
  viewport: HTMLElement | null;
  loadEarlier: CitationHistoryPage | null;
  onExpandRun: (runId: RunId) => void;
  onExpandAttempt: (attemptId: RunAttemptId) => void;
  onManualNavigation: () => void;
}) {
  const [settledKey, setSettledKey] = useState<string | null>(null);
  // Effects read the ref; the state re-renders the list's scroll props.
  const settledKeyRef = useRef<string | null>(null);
  const settle = useCallback((key: string) => {
    settledKeyRef.current = key;
    setSettledKey(key);
  }, []);
  const requestedPagesRef = useRef<{ key: string; cursors: Set<string> } | null>(null);

  // Reveal: load and unfold until the message has a row.
  useEffect(() => {
    if (!target) return;
    if (requestedPagesRef.current?.key !== target.key) {
      requestedPagesRef.current = { key: target.key, cursors: new Set() };
      onManualNavigation();
    }
    if (settledKeyRef.current === target.key) return;
    const loaded = entries.some(
      (entry) => entry.kind === "message" && entry.message.id === target.messageId,
    );
    if (!loaded) {
      if (loadEarlier?.loading) return;
      const cursor = loadEarlier?.cursor ?? entries[0]?.id ?? "first";
      // No more pages, or a page that did not move: the message is not reachable.
      const cursors = requestedPagesRef.current.cursors;
      if (!loadEarlier || cursors.has(cursor)) {
        settle(target.key);
        return;
      }
      cursors.add(cursor);
      loadEarlier.onLoadEarlier();
      return;
    }
    if (rows.some((row) => row.kind === "message" && row.message.id === target.messageId)) return;
    const folds = timelineMessageFolds(entries, target.messageId);
    if (folds.runId) onExpandRun(folds.runId);
    if (folds.attemptId) onExpandAttempt(folds.attemptId);
  }, [
    entries,
    loadEarlier,
    onExpandAttempt,
    onExpandRun,
    onManualNavigation,
    rows,
    settle,
    target,
  ]);

  // A user scroll at any point, even while older pages load, ends find's navigation.
  // Scroll keys count unless they are typed into a field such as the find input.
  // The match stays highlighted.
  useEffect(() => {
    if (!target || !viewport) return;
    const stop = () => {
      if (settledKeyRef.current === target.key) return;
      settle(target.key);
      const list = listRef.current;
      const scrollNode = list?.getScrollableNode();
      // Supersede a pending list scroll before the gesture applies.
      if (list && scrollNode instanceof HTMLElement) {
        void list.scrollToOffset({ offset: scrollNode.scrollTop, animated: false });
      }
    };
    const onScrollKey = (event: KeyboardEvent) => {
      if (
        SCROLL_KEYS.has(event.key) &&
        !(event.target instanceof Element && event.target.closest(EDITABLE_SELECTOR))
      ) {
        stop();
      }
    };
    const ownerDocument = viewport.ownerDocument;
    viewport.addEventListener("wheel", stop, { passive: true });
    viewport.addEventListener("touchmove", stop, { passive: true });
    viewport.addEventListener("pointerdown", stop, { passive: true });
    ownerDocument.addEventListener("keydown", onScrollKey);
    return () => {
      viewport.removeEventListener("wheel", stop);
      viewport.removeEventListener("touchmove", stop);
      viewport.removeEventListener("pointerdown", stop);
      ownerDocument.removeEventListener("keydown", onScrollKey);
    };
  }, [listRef, settle, target, viewport]);

  const rowId = target
    ? rows.find((row) => row.kind === "message" && row.message.id === target.messageId)?.id
    : undefined;

  // Scroll once, then keep the highlight in sync as the row re-renders or streams.
  useEffect(() => {
    const list = listRef.current;
    const scrollNode = list?.getScrollableNode();
    if (!target || rowId === undefined || !list || !viewport) return;
    if (!(scrollNode instanceof HTMLElement)) return;
    let disposed = false;
    let scrolling = false;
    let attempts = 0;
    let frame: number | null = null;
    const settled = () => settledKeyRef.current === target.key;
    const paint = () => {
      frame = null;
      const state = list.getState();
      const index = state.indexByKey(rowId);
      if (index === undefined) return;
      const row = scrollNode.querySelector<HTMLElement>(
        `[data-timeline-row-id="${CSS.escape(rowId)}"]`,
      );
      if (!row || !(state.sizeAtIndex(index) > 0)) {
        // Off-screen virtual rows have no DOM yet. Bring the row in first.
        if (settled() || scrolling) return;
        scrolling = true;
        void Promise.resolve(
          list.scrollToIndex({ index, animated: false, viewPosition: 0.3 }),
        ).then(() => {
          scrolling = false;
          schedule();
        });
        return;
      }
      const ranges = findTextRanges(
        row.querySelector<HTMLElement>(MESSAGE_BODY_SELECTOR) ?? row,
        target.query,
      );
      const active = ranges[Math.min(target.occurrence, ranges.length - 1)] ?? null;
      if (typeof Highlight !== "undefined" && CSS.highlights) {
        CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...ranges));
        if (active) CSS.highlights.set(ACTIVE_MATCH_HIGHLIGHT, new Highlight(active));
        else CSS.highlights.delete(ACTIVE_MATCH_HIGHLIGHT);
      }
      if (settled() || scrolling) return;
      const rect = (active ?? row).getBoundingClientRect();
      const bounds = scrollNode.getBoundingClientRect();
      // The composer can cover the bottom of the list, so only the top two thirds count.
      const visible = rect.top >= bounds.top && rect.bottom <= bounds.top + bounds.height * (2 / 3);
      if (visible || attempts >= MAX_SCROLL_ATTEMPTS) {
        settle(target.key);
        return;
      }
      attempts += 1;
      scrolling = true;
      const offset = Math.max(
        0,
        Math.min(
          scrollNode.scrollHeight - scrollNode.clientHeight,
          scrollNode.scrollTop + rect.top - bounds.top - Math.min(120, scrollNode.clientHeight / 3),
        ),
      );
      void list.scrollToOffset({ offset, animated: false }).then(() => {
        scrolling = false;
        schedule();
      });
    };
    // Pending list scrolls resolve after cleanup; they must not repaint an old target.
    const schedule = () => {
      if (!disposed && frame === null) frame = requestAnimationFrame(paint);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(scrollNode, { childList: true, subtree: true, characterData: true });
    const stopListening = list.getState().listenToPosition(rowId, schedule);
    schedule();
    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      if (scrolling) void list.scrollToOffset({ offset: scrollNode.scrollTop, animated: false });
      observer.disconnect();
      stopListening();
      clearHighlights();
    };
  }, [listRef, rowId, settle, target, viewport]);

  const positioning = target !== null && settledKey !== target.key;
  return {
    positioning,
    /** Keeps the target row mounted while find scrolls to it. */
    pinnedRowId: positioning ? rowId : undefined,
  };
}
