import type { ScopedThreadRef, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import type { ComponentProps } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { useServerConfigs } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { MenuCheckboxItem, MenuItem, MenuItemLabel } from "../ui/menu";
import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";

const isOpen = (link: ThreadPullRequestLink) =>
  link.snapshot === null || link.snapshot.state === "open";

/**
 * The thread details card's pull request row, with the thread's monitoring in its menu.
 *
 * A thread can monitor several pull requests, so the menu has a "Monitor" switch for the current
 * one and for each other one the agent monitors. Other linked pull requests live in the Linked
 * PRs panel, which the menu opens.
 */
export function ThreadDetailsPrRows({
  threadRef,
  links,
  currentLink,
  ...row
}: Omit<ComponentProps<typeof ThreadDetailsPrRow>, "trailing" | "menu"> & {
  threadRef: ScopedThreadRef;
  links: ReadonlyArray<ThreadPullRequestLink>;
  currentLink: ThreadPullRequestLink | null;
}) {
  const supportsWatch =
    useServerConfigs().get(threadRef.environmentId)?.environment.capabilities
      .threadPullRequestWatch === true;
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });

  const visible = visibleThreadPullRequests(links);
  const currentKey = currentLink === null ? null : threadPullRequestKeyOf(currentLink);
  const isCurrent = (link: ThreadPullRequestLink) => threadPullRequestKeyOf(link) === currentKey;
  const monitorable = supportsWatch
    ? [
        ...(currentLink !== null && isOpen(currentLink) ? [currentLink] : []),
        ...visible.filter((link) => link.watch !== undefined && !isCurrent(link)),
      ]
    : [];
  const monitoring = monitorable.some((link) => link.watch !== undefined);

  const setWatching = (link: ThreadPullRequestLink, watching: boolean) =>
    void watch({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        host: link.host,
        repository: link.repository,
        number: link.number,
        watching,
      },
    });

  const hasOtherLinks = visible.some((link) => !isCurrent(link));
  const menu =
    monitorable.length === 0 && !hasOtherLinks ? undefined : (
      <>
        {monitorable.map((link) => (
          <MenuCheckboxItem
            key={threadPullRequestKeyOf(link)}
            variant="switch"
            checked={link.watch !== undefined}
            onCheckedChange={(checked) => setWatching(link, checked)}
          >
            {monitorable.length === 1 ? "Monitor" : `Monitor #${link.number}`}
          </MenuCheckboxItem>
        ))}
        {hasOtherLinks ? (
          <MenuItem onClick={() => useRightPanelStore.getState().open(threadRef, "pull-requests")}>
            <MenuItemLabel>All linked PRs</MenuItemLabel>
          </MenuItem>
        ) : null}
      </>
    );

  return (
    <ThreadDetailsPrRow {...row} trailing={monitoring ? "Monitoring" : undefined} menu={menu} />
  );
}
