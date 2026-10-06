import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
/**
 * The thread details panel's pull request row: what the thread's pull request is, and the one
 * thing worth doing to it right now.
 *
 * The row stays one line, like every other row in the card. Clicking it opens the pull request
 * in the right panel. Its chevron opens a menu led by the next action, ranked by what unblocks the
 * merge: "Resolve", "Ready", "Fix", or "Merge" once the branch is clean and its checks pass. No
 * merge is offered while checks run, since it would race the runs that gate it. The caller adds
 * its own menu items (`menu`) and a quiet trailing label (`trailing`).
 *
 * Until the detail arrives — or where pull requests are not supported at all — the row renders
 * from the linked snapshot or branch summary, or just the link when status is unavailable.
 */
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, PullRequestRef } from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import { ArrowUpRightIcon, ChevronDownIcon } from "lucide-react";
import { useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { usePullRequestChecksRefresh } from "~/hooks/usePullRequestChecksRefresh";
import { cn } from "~/lib/utils";
import { useServerConfigs } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import {
  buildFixFindingsHandoff,
  buildResolveConflictsPrompt,
  resolveSelectedMergeMethod,
  allowedPullRequestMergeMethods,
  resolveThreadPanelPullRequestAction,
} from "../pullRequest/pullRequestDetail.logic";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import {
  usePullRequestActionRunner,
  usePullRequestHandoffs,
} from "../pullRequest/usePullRequestActions";
import {
  ChangeRequestStatusIcon,
  type PrStatusIndicator,
  type ThreadPr,
} from "../ThreadStatusIndicators";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

export function ThreadDetailsPrRow({
  environmentId,
  pr,
  number,
  reference: linkedReference,
  status,
  project,
  label,
  openAriaLabel,
  onOpen,
  onActed,
  url,
  trailing,
  menu,
}: {
  environmentId: EnvironmentId;
  pr: ThreadPr;
  number: number;
  reference?: Pick<PullRequestRef, "host" | "repository" | "number"> | null;
  status: PrStatusIndicator | null;
  /** The thread's project, which is what the pull request is read through on the host. */
  project: EnvironmentProject | null;
  label: string;
  openAriaLabel: string;
  onOpen: (event: ReactMouseEvent<HTMLElement>) => void;
  /** An action changed the pull request on the host, so the vcs status behind the row is stale. */
  onActed?: () => void;
  url: string;
  /** Quiet text at the row's end, such as "Monitoring". */
  trailing?: ReactNode;
  /** Extra items for the row's menu, placed after the next action. */
  menu?: ReactNode;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const serverConfigs = useServerConfigs();
  const supportsPullRequests =
    serverConfigs.get(environmentId)?.environment.capabilities.pullRequests === true;
  const repository = sourceControlRepositorySelector(project?.repositoryIdentity);
  const reference: PullRequestRef | null =
    supportsPullRequests && project !== null
      ? linkedReference
        ? { ...linkedReference, projectId: project.id as ProjectId }
        : repository !== null
          ? { projectId: project.id as ProjectId, repository, number }
          : null
      : null;
  const detailQuery = useEnvironmentQuery(
    reference === null
      ? null
      : pullRequestEnvironment.detail({
          environmentId,
          input: { ...reference, allowStale: false },
        }),
  );
  const supportsChecks =
    serverConfigs.get(environmentId)?.environment.capabilities.pullRequestChecks === true;
  const checksQuery = useEnvironmentQuery(
    supportsChecks && reference !== null && detailQuery.data !== null
      ? pullRequestEnvironment.checks({ environmentId, input: reference })
      : null,
  );
  const detail =
    detailQuery.data === null
      ? null
      : checksQuery.data !== null && checksQuery.dataUpdatedAt >= detailQuery.dataUpdatedAt
        ? { ...detailQuery.data, ...checksQuery.data }
        : detailQuery.data;
  const open = reference !== null && (detail?.state ?? pr?.state) === "open";
  const refreshKey = `${environmentId}:${project?.id}:${reference?.host}:${reference?.repository}:${number}`;
  useLiveRefresh(detailQuery.isPending ? null : detailQuery.refresh, {
    enabled: open,
    key: `workspace-pr:${refreshKey}`,
    intervalMs: 10 * 60_000,
  });
  usePullRequestChecksRefresh({
    refresh: checksQuery.isPending || detailQuery.isPending ? null : checksQuery.refresh,
    enabled: open && supportsChecks && !(checksQuery.isSuccess && checksQuery.data === null),
    key: `workspace-pr-checks:${refreshKey}`,
    checks: detail?.checks ?? [],
  });

  const { actionPending, perform } = usePullRequestActionRunner({
    environmentId,
    reference,
    onSuccess: () => {
      detailQuery.refresh();
      checksQuery.refresh();
      onActed?.();
    },
  });
  const { handoff, startHandoff } = usePullRequestHandoffs({ environmentId, detail });
  const [confirmingMerge, setConfirmingMerge] = useState(false);

  const rowAction = resolveThreadPanelPullRequestAction(detail);
  if (confirmingMerge && rowAction !== "merge") {
    setConfirmingMerge(false);
  }
  const selectedMergeMethod = resolveSelectedMergeMethod(
    allowedPullRequestMergeMethods(detail),
    "merge",
  );

  const startResolveConflicts = () => {
    if (detail === null) return;
    void startHandoff("conflicts", {
      prompt: buildResolveConflictsPrompt({
        number: detail.number,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
      }),
    });
  };

  const startFixChecks = () => {
    if (detail === null) return;
    // The compact row fetches no conversation, so the handoff carries the failing checks alone;
    // review threads keep arriving through the full panel's richer version of this action.
    void startHandoff(
      "findings",
      buildFixFindingsHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        reviewThreads: [],
        comments: [],
        checks: detail.checks,
        commentsTruncated: false,
      }),
    );
  };

  // Host details distinguish drafts; all panels share the same PR-state glyph.
  const statePresentation =
    detail === null
      ? null
      : resolvePullRequestState({
          state: detail.state,
          isDraft: detail.isDraft,
        });
  const icon = statePresentation ? (
    <statePresentation.Icon
      aria-hidden
      className={cn("size-4 shrink-0", statePresentation.toneClassName)}
    />
  ) : pr && status ? (
    <ChangeRequestStatusIcon
      state={pr.state}
      className={cn(THREAD_DETAILS_PANEL_ICON_CLASS, status.colorClass)}
    />
  ) : (
    <PullRequestGlyph.pullRequest className={THREAD_DETAILS_PANEL_ICON_CLASS} />
  );

  // The one thing worth doing next, ranked by what unblocks the merge. It leads the row's menu.
  const nextAction =
    rowAction === "resolve"
      ? {
          label: "Resolve",
          pendingLabel: "Preparing...",
          pending: handoff === "conflicts",
          destructive: true,
          handoff: true,
          onClick: startResolveConflicts,
        }
      : rowAction === "ready"
        ? {
            label: "Ready",
            pendingLabel: "Marking...",
            pending: actionPending,
            destructive: false,
            handoff: false,
            onClick: () => void perform("ready"),
          }
        : rowAction === "fix"
          ? {
              label: "Fix",
              pendingLabel: "Preparing...",
              pending: handoff === "findings",
              destructive: true,
              handoff: true,
              onClick: startFixChecks,
            }
          : rowAction === "merge"
            ? {
                label: "Merge",
                pendingLabel: "Merging...",
                pending: actionPending,
                destructive: false,
                handoff: false,
                onClick: () => setConfirmingMerge(true),
              }
            : null;

  return (
    <>
      <div ref={anchorRef} className={THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS}>
        <ThreadDetailsControl
          type="button"
          variant="ghost"
          size="sm"
          part="link-primary"
          aria-label={openAriaLabel}
          onClick={onOpen}
        >
          {icon}
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          {trailing ? (
            <span className="shrink-0 text-3xs font-normal text-muted-foreground/70">
              {trailing}
            </span>
          ) : null}
        </ThreadDetailsControl>
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
        <Menu>
          <MenuTrigger
            render={
              <ThreadDetailsControl
                type="button"
                variant="ghost"
                size="sm"
                part="secondary"
                aria-label={`Options for #${number}`}
              />
            }
          >
            <ChevronDownIcon aria-hidden className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
          </MenuTrigger>
          <MenuPopup align="end" anchor={anchorRef} className="w-(--anchor-width)">
            {nextAction ? (
              <MenuItem
                variant={nextAction.destructive ? "destructive" : "default"}
                disabled={actionPending || handoff !== null}
                onClick={nextAction.onClick}
              >
                <MenuItemLabel>
                  {nextAction.pending ? nextAction.pendingLabel : nextAction.label}
                </MenuItemLabel>
                {nextAction.handoff ? (
                  <ArrowUpRightIcon aria-hidden className="ms-auto size-3.5" />
                ) : null}
              </MenuItem>
            ) : null}
            {nextAction && menu ? <MenuSeparator /> : null}
            {menu}
            {nextAction || menu ? <MenuSeparator /> : null}
            <MenuItem onClick={() => void writeTextToClipboard(url, "link")}>
              <MenuItemLabel>Copy link</MenuItemLabel>
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {rowAction === "merge" ? (
        <AlertDialog open={confirmingMerge} onOpenChange={(open) => setConfirmingMerge(open)}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Merge pull request?</AlertDialogTitle>
              <AlertDialogDescription>
                This merges #{number} using {selectedMergeMethod}.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" size="sm" />}>
                Cancel
              </AlertDialogClose>
              <Button
                size="sm"
                disabled={actionPending}
                onClick={() => {
                  setConfirmingMerge(false);
                  void perform("merge", selectedMergeMethod);
                }}
              >
                Merge
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      ) : null}
    </>
  );
}
