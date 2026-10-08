import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { threadFindIndex, threadFindPosition, type ThreadFindPosition } from "./threadFind.logic";
import type { ThreadFindTarget } from "./useThreadFindTarget";

const FIND_DEBOUNCE_MS = 150;
const NO_MATCHES = [] as const;

/**
 * Cmd+F for the open thread. The server searches the whole saved history,
 * so matches in turns that are not loaded or not rendered count too. Enter
 * walks up toward older matches, since a thread is read from the bottom.
 */
export function ThreadFindBar({
  threadRef,
  revision,
  focusRequest,
  onTarget,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  /** Changes when the thread gains messages, so the results refresh. */
  revision: number;
  /** Changes on every Cmd+F, to focus and select the query again. */
  focusRequest: number;
  onTarget: (target: ThreadFindTarget | null) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<ThreadFindPosition | null>(null);
  const [navigation, setNavigation] = useState(0);
  const settledQuery = useDebouncedValue(query.trim(), FIND_DEBOUNCE_MS);
  const result = useEnvironmentQuery(
    settledQuery
      ? orchestrationEnvironment.threadFind({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, query: settledQuery },
        })
      : null,
  );
  const matches = result.data?.matches ?? NO_MATCHES;
  const { index, total } = useMemo(() => threadFindIndex(matches, position), [matches, position]);
  const pending = query.trim() !== settledQuery || result.isPending;

  const focusedRequestRef = useRef<number | null>(null);
  useEffect(() => {
    if (focusedRequestRef.current === focusRequest) return;
    focusedRequestRef.current = focusRequest;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  const { refresh } = result;
  const lastRevisionRef = useRef(revision);
  useEffect(() => {
    if (lastRevisionRef.current === revision) return;
    lastRevisionRef.current = revision;
    refresh();
  }, [refresh, revision]);

  const current = total > 0 ? threadFindPosition(matches, index) : null;
  const messageId = current?.messageId;
  const occurrence = current?.occurrence;
  const target = useMemo<ThreadFindTarget | null>(
    () =>
      messageId !== undefined && occurrence !== undefined && settledQuery
        ? {
            messageId,
            occurrence,
            query: settledQuery,
            key: `${settledQuery}\u0000${messageId}\u0000${occurrence}\u0000${navigation}`,
          }
        : null,
    [messageId, navigation, occurrence, settledQuery],
  );
  useEffect(() => onTarget(target), [onTarget, target]);
  useEffect(() => () => onTarget(null), [onTarget]);

  const move = (step: -1 | 1) => {
    if (total === 0) return;
    setPosition(threadFindPosition(matches, (index + step + total) % total));
    setNavigation((count) => count + 1);
  };

  const status = !settledQuery
    ? ""
    : result.error
      ? "Find failed"
      : total === 0
        ? pending
          ? ""
          : "No results"
        : `${index + 1}/${total}${result.data?.truncated ? "+" : ""}`;

  return (
    <div
      role="search"
      className="absolute top-2 left-1/2 z-30 flex w-80 max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 rounded-lg border border-border bg-background py-0.5 pr-0.5 pl-1"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === "Enter" && event.target === inputRef.current) {
          event.preventDefault();
          move(event.shiftKey ? 1 : -1);
        }
      }}
    >
      <Input
        ref={inputRef}
        unstyled
        size="compact"
        type="search"
        aria-label="Find in thread"
        placeholder="Find in thread"
        data-thread-find-input
        value={query}
        maxLength={200}
        onChange={(event) => {
          setQuery(event.target.value);
          setPosition(null);
        }}
      />
      <span
        role="status"
        aria-live="polite"
        className="shrink-0 px-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
      >
        {status}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Older match"
        title="Older match (Enter)"
        disabled={total === 0}
        onClick={() => move(-1)}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Newer match"
        title="Newer match (Shift+Enter)"
        disabled={total === 0}
        onClick={() => move(1)}
      >
        <ChevronDownIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Close find"
        title="Close (Escape)"
        onClick={onClose}
      >
        <XIcon />
      </Button>
    </div>
  );
}
