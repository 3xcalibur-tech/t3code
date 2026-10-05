import {
  EnvironmentId,
  OrchestratorMcpFailure,
  OrchestratorMcpTarget,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadWaitResult,
  PeerCapabilities,
  PeerLaunchCode,
  PeerLaunchResult,
  PeerProjectsResult,
  PeerTarget,
  PositiveInt,
  ProjectId,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerTargets from "../../../peer/PeerTargets.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const environmentId = EnvironmentId.annotate({
  description: "Peer environment id from t3_peer_targets.",
});

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PeerTargets.PeerTargets,
    Crypto.Crypto,
  ],
};

const PeerTargetsTool = Tool.make("t3_peer_targets", {
  ...shared,
  description:
    "List other T3 Code environments (machines) this environment can hand work to, and whether each one answers now. A user sets each one up with a grant from the other environment.",
  success: Schema.Struct({
    targets: Schema.Array(Schema.Struct({ ...PeerTarget.fields, reachable: Schema.Boolean })),
  }),
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const PeerCapabilitiesTool = Tool.make("t3_peer_capabilities", {
  ...shared,
  description:
    "Read what a peer environment lets this environment do: granted projects, the broadest runtime and interaction modes, whether setup scripts run, and its providers and models.",
  parameters: Schema.Struct({ environmentId }),
  success: PeerCapabilities,
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const PeerProjectsTool = Tool.make("t3_peer_projects", {
  ...shared,
  description: "List the projects a peer environment granted to this environment.",
  parameters: Schema.Struct({ environmentId }),
  success: PeerProjectsResult,
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const PeerLaunchTool = Tool.make("t3_peer_launch", {
  ...shared,
  description:
    "Start a new thread in a peer environment, in a fresh worktree at an exact commit. Push the commit first; the peer fetches `ref` from its remote and never falls back to a local ref. Modes cannot be broader than this thread's or the grant's. Follow the result with t3_peer_wait and t3_peer_read.",
  parameters: Schema.Struct({
    environmentId,
    projectId: ProjectId.annotate({ description: "Project id from t3_peer_projects." }),
    prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
      description: "Complete task for the peer agent. It has none of this thread's context.",
    }),
    title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
    code: PeerLaunchCode,
    target: Schema.optional(OrchestratorMcpTarget),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    clientRequestId: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
        description: "Stable idempotency key to reuse when retrying this launch.",
      }),
    ),
  }),
  success: PeerLaunchResult,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const PeerReadTool = Tool.make("t3_peer_read", {
  ...shared,
  description:
    "Read a thread this environment started in a peer environment. Same paging as t3_thread_read.",
  parameters: Schema.Struct({ environmentId, ...OrchestratorMcpThreadReadInput.fields }),
  success: OrchestratorMcpThreadReadResult,
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const PeerWaitTool = Tool.make("t3_peer_wait", {
  ...shared,
  description:
    "Wait until a thread this environment started in a peer environment finishes its run, or until timeoutMs passes (default 10 minutes, max 60).",
  parameters: Schema.Struct({
    environmentId,
    threadId: ThreadId,
    runId: Schema.optional(RunId),
    timeoutMs: Schema.optional(PositiveInt),
  }),
  success: OrchestratorMcpThreadWaitResult,
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const PeerInterruptTool = Tool.make("t3_peer_interrupt", {
  ...shared,
  description:
    "Interrupt the active run of a thread this environment started in a peer environment.",
  parameters: Schema.Struct({ environmentId, ...OrchestratorMcpThreadInterruptInput.fields }),
  success: OrchestratorMcpThreadInterruptResult,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const PeerToolkit = Toolkit.make(
  PeerTargetsTool,
  PeerCapabilitiesTool,
  PeerProjectsTool,
  PeerLaunchTool,
  PeerReadTool,
  PeerWaitTool,
  PeerInterruptTool,
);
