import {
  nextProjectPinOrderKey,
  planProjectPinReorder,
} from "@t3tools/client-runtime/state/project-organization";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ProjectIconOverride } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { useEnvironments } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";

/** Fields every machine's record of one logical project shares. */
interface ProjectGroupFields {
  readonly title?: string;
  readonly faviconPath?: string | null;
  readonly projectIcon?: ProjectIconOverride | null;
  readonly pinned?: boolean;
  readonly pinOrderKey?: string | null;
  readonly archived?: boolean;
}

type ProjectGroup = Pick<
  SidebarProjectSnapshot,
  "projectKey" | "displayName" | "memberProjects" | "pinnedAt" | "pinOrderKey"
>;

type GroupResult = AtomCommandResult<void, unknown>;

/**
 * Edits one logical project. Its shared fields live on each machine's
 * record, so every edit writes every member, and none starts while a member's
 * machine is offline.
 */
export function useProjectGroupActions() {
  const { environments } = useEnvironments();
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });

  const reportFailure = useCallback((title: string, result: GroupResult) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);

  const updateGroup = useCallback(
    async (
      group: ProjectGroup,
      input: ProjectGroupFields,
      failureTitle: string,
    ): Promise<GroupResult> => {
      const unavailable = group.memberProjects.find((member) => {
        const environment = environmentById.get(member.environmentId);
        return environment?.connection.phase !== "connected" || !environment.serverConfig;
      });
      if (unavailable) {
        const result: GroupResult = AsyncResult.failure(
          Cause.fail(
            new Error(
              `Connect ${unavailable.environmentLabel ?? "the selected environment"} and try again.`,
            ),
          ),
        );
        reportFailure(failureTitle, result);
        return result;
      }
      for (const member of group.memberProjects) {
        const result = mapAtomCommandResult(
          await updateProject({
            environmentId: member.environmentId,
            input: { projectId: member.id, ...input },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          // Earlier members already took the write, so name where it stopped.
          reportFailure(
            group.memberProjects.length > 1
              ? `${failureTitle} on ${member.environmentLabel ?? "the current environment"}`
              : failureTitle,
            result,
          );
          return result;
        }
      }
      return AsyncResult.success(undefined);
    },
    [environmentById, reportFailure, updateProject],
  );

  const unorganizableMember = useCallback(
    (group: Pick<SidebarProjectSnapshot, "memberProjects">) =>
      group.memberProjects.find(
        (member) =>
          environmentById.get(member.environmentId)?.serverConfig?.environment.capabilities
            .projectOrganization !== true,
      ),
    [environmentById],
  );

  /** True when every machine with the project can store its pin and archive. */
  const canOrganize = useCallback(
    (group: Pick<SidebarProjectSnapshot, "memberProjects">) =>
      unorganizableMember(group) === undefined,
    [unorganizableMember],
  );

  // Older servers drop pin and archive fields, so refuse instead of writing
  // to only some machines.
  const organizeGroup = useCallback(
    async (
      group: ProjectGroup,
      input: Pick<ProjectGroupFields, "pinned" | "pinOrderKey" | "archived">,
      failureTitle: string,
    ): Promise<GroupResult> => {
      const outdated = unorganizableMember(group);
      if (outdated) {
        const result: GroupResult = AsyncResult.failure(
          Cause.fail(
            new Error(
              `Update ${outdated.environmentLabel ?? "the selected environment"} to pin and archive projects.`,
            ),
          ),
        );
        reportFailure(failureTitle, result);
        return result;
      }
      return updateGroup(group, input, failureTitle);
    },
    [reportFailure, unorganizableMember, updateGroup],
  );

  /** Pins after every pinned project in `groups`, or unpins. */
  const setPinned = useCallback(
    (group: ProjectGroup, pinned: boolean, groups: ReadonlyArray<ProjectGroup>) =>
      organizeGroup(
        group,
        pinned ? { pinned: true, pinOrderKey: nextProjectPinOrderKey(groups) } : { pinned: false },
        pinned ? `Failed to pin ${group.displayName}` : `Failed to unpin ${group.displayName}`,
      ),
    [organizeGroup],
  );

  /** Saves a dragged order of the pinned projects. */
  const reorderPinned = useCallback(
    async (orderedGroups: ReadonlyArray<ProjectGroup>, movedKey: string): Promise<GroupResult> => {
      const groupByKey = new Map(orderedGroups.map((group) => [group.projectKey, group]));
      const writes = planProjectPinReorder({
        orderedKeys: orderedGroups.map((group) => group.projectKey),
        pinOrderKeyByKey: new Map(
          orderedGroups.map((group) => [group.projectKey, group.pinOrderKey ?? null]),
        ),
        movedKey,
      });
      for (const write of writes) {
        const group = groupByKey.get(write.key);
        if (!group) continue;
        const result = await organizeGroup(
          group,
          { pinned: true, pinOrderKey: write.pinOrderKey },
          "Failed to reorder pinned projects",
        );
        if (result._tag === "Failure") return result;
      }
      return AsyncResult.success(undefined);
    },
    [organizeGroup],
  );

  /** Archives with an Undo toast, or unarchives. Threads keep their state. */
  const setArchived = useCallback(
    async (group: ProjectGroup, archived: boolean): Promise<GroupResult> => {
      const unarchive = () =>
        organizeGroup(group, { archived: false }, `Failed to unarchive ${group.displayName}`);
      if (!archived) return unarchive();
      const result = await organizeGroup(
        group,
        { archived: true },
        `Failed to archive ${group.displayName}`,
      );
      if (result._tag === "Success") {
        const toastId = toastManager.add({
          type: "success",
          title: `Archived ${group.displayName}`,
          description: "Its threads are hidden until you unarchive it in Settings → Projects.",
          timeout: 5_000,
          actionProps: {
            children: "Undo",
            onClick: () => {
              toastManager.close(toastId);
              void unarchive();
            },
          },
          data: { hideCopyButton: true },
        });
      }
      return result;
    },
    [organizeGroup],
  );

  return { updateGroup, canOrganize, setPinned, reorderPinned, setArchived };
}
