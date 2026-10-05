import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  encodePeerSetupString,
  isAllowedPeerUrl,
  type AdvertisedEndpoint,
  type AuthEnvironmentScope,
  type PeerGrant,
  type PeerTarget,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import {
  addServerPeerTarget,
  createServerPeerGrant,
  listServerPeerGrants,
  listServerPeerTargets,
  removeServerPeerTarget,
  revokeServerPeerGrant,
} from "~/environments/primary";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId, useRelayEnvironmentDiscovery } from "~/state/environments";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { selectPeerEndpoints } from "./ConnectionsSettings.logic";

/** Select value for typing an address that is not in the list. */
const CUSTOM_ENDPOINT = "custom";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { searchableSetting } from "./settingsSearch";

const RUNTIME_MODE_ITEMS = runtimeModeOptions.map((mode) => ({
  value: mode,
  label: runtimeModeConfig[mode].label,
}));

const INTERACTION_MODE_LABELS: Record<ProviderInteractionMode, string> = {
  default: "Build and plan",
  plan: "Plan only",
};
const INTERACTION_MODE_ITEMS = (["default", "plan"] as const).map((mode) => ({
  value: mode,
  label: INTERACTION_MODE_LABELS[mode],
}));

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Loads a list from the primary environment on mount and on `refresh`. A late response never overwrites a newer one. */
function usePrimaryList<T>(load: () => Promise<ReadonlyArray<T>>) {
  const [items, setItems] = useState<ReadonlyArray<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const refresh = useCallback(() => {
    const request = ++requestRef.current;
    load().then(
      (next) => {
        if (requestRef.current !== request) return;
        setItems(next);
        setError(null);
      },
      (cause: unknown) => {
        if (requestRef.current !== request) return;
        setError(errorMessage(cause, "Could not load."));
      },
    );
  }, [load]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { items, error, refresh };
}

function ListStatusRow({ error, empty }: { error: string | null; empty: string | null }) {
  if (error === null && empty === null) return null;
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <p className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground/60"}>
        {error ?? empty}
      </p>
    </div>
  );
}

/**
 * Peer access for the primary environment. Admins grant another environment's
 * agents scoped access here, and any session that can operate threads adds
 * the setup strings this environment uses to hand work to others.
 */
export function PeerAccessSettings({
  canManageGrants,
  scopes,
  endpoints,
  defaultEndpointKey,
}: {
  readonly canManageGrants: boolean;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope> | null;
  /** This environment's advertised endpoints; only HTTPS and loopback ones are offered. */
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly defaultEndpointKey: string | null;
}) {
  const canReadTargets =
    !isLocalEnvironmentDisabled() && (scopes?.includes(AuthOrchestrationReadScope) ?? false);
  const canEditTargets =
    canReadTargets && (scopes?.includes(AuthOrchestrationOperateScope) ?? false);
  return (
    <>
      {canManageGrants ? (
        <PeerGrantsSection endpoints={endpoints} defaultEndpointKey={defaultEndpointKey} />
      ) : null}
      {canReadTargets ? <PeerTargetsSection canEdit={canEditTargets} /> : null}
    </>
  );
}

function PeerGrantsSection({
  endpoints,
  defaultEndpointKey,
}: {
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly defaultEndpointKey: string | null;
}) {
  const grants = usePrimaryList(listServerPeerGrants);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // The relay knows this environment's T3 Connect address; the server does not.
  const relayDiscovery = useRelayEnvironmentDiscovery();
  const connectEndpoint =
    primaryEnvironmentId === null
      ? undefined
      : relayDiscovery.environments.get(primaryEnvironmentId)?.environment.endpoint;
  const connectUrl =
    connectEndpoint !== undefined && connectEndpoint.providerKind !== "manual"
      ? connectEndpoint.httpBaseUrl
      : null;
  const allProjects = useProjects();
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === primaryEnvironmentId),
    [allProjects, primaryEnvironmentId],
  );
  const projectTitles = useMemo(
    () => new Map(projects.map((project) => [project.id, project.title])),
    [projects],
  );
  const [revokingId, setRevokingId] = useState<PeerGrant["id"] | null>(null);

  const handleRevoke = async (grant: PeerGrant) => {
    // Fail closed: no mounted confirm host means no revoke.
    const confirmed = await requestConfirmDialog(
      `Revoke "${grant.label}"?\nThe other environment can no longer start or follow work here.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setRevokingId(grant.id);
    try {
      await revokeServerPeerGrant(grant.id);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not revoke grant",
          description: errorMessage(error, "Failed to revoke grant."),
        }),
      );
    } finally {
      setRevokingId(null);
      grants.refresh();
    }
  };

  const { id, title } = searchableSetting("peer-grants");
  const items = grants.items ?? [];
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={grants.items ? countLabel(items.length, "grant") : null}
      control={
        <NewPeerGrantDialog
          projects={projects}
          endpoints={endpoints}
          defaultEndpointKey={defaultEndpointKey}
          connectUrl={connectUrl}
          onCreated={grants.refresh}
        />
      }
    >
      <ListStatusRow
        error={grants.error}
        empty={grants.items !== null && items.length === 0 ? "No peer grants." : null}
      />
      {items.map((grant) => (
        <div key={grant.id} className={ITEM_ROW_CLASSNAME}>
          <div className={ITEM_ROW_INNER_CLASSNAME}>
            <div className="min-w-0 flex-1 space-y-1">
              <h3 className="text-sm font-medium text-foreground">{grant.label}</h3>
              <p className="text-xs text-muted-foreground">
                {grant.projectIds
                  .map((id) => projectTitles.get(id) ?? "Removed project")
                  .join(", ")}
              </p>
              <p className="text-xs text-muted-foreground">
                {[
                  `Up to ${runtimeModeConfig[grant.maxRuntimeMode].label}`,
                  INTERACTION_MODE_LABELS[grant.maxInteractionMode],
                  grant.runSetupScripts ? "Setup scripts on" : "Setup scripts off",
                  grant.lastUsedAt
                    ? `Used ${formatRelativeTimeLabel(DateTime.formatIso(grant.lastUsedAt))}`
                    : "Never used",
                ].join(" · ")}
              </p>
            </div>
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={revokingId === grant.id}
              onClick={() => void handleRevoke(grant)}
            >
              {revokingId === grant.id ? "Revoking…" : "Revoke"}
            </Button>
          </div>
        </div>
      ))}
    </FoldedSettingsSection>
  );
}

function NewPeerGrantDialog({
  projects,
  endpoints,
  defaultEndpointKey,
  connectUrl,
  onCreated,
}: {
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly defaultEndpointKey: string | null;
  readonly connectUrl: string | null;
  readonly onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [projectIds, setProjectIds] = useState<ReadonlyArray<ProjectId>>([]);
  const [maxRuntimeMode, setMaxRuntimeMode] = useState<RuntimeMode>("auto");
  const [maxInteractionMode, setMaxInteractionMode] = useState<ProviderInteractionMode>("default");
  const [runSetupScripts, setRunSetupScripts] = useState(false);
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  // The secret exists only in this state; closing the dialog drops it.
  const [setupString, setSetupString] = useState<string | null>(null);

  const peerEndpoints = useMemo(
    () => selectPeerEndpoints(endpoints, defaultEndpointKey, connectUrl),
    [connectUrl, defaultEndpointKey, endpoints],
  );
  const endpointChoice = endpointId ?? peerEndpoints.selected ?? CUSTOM_ENDPOINT;
  const selectedEndpoint = peerEndpoints.options.find((endpoint) => endpoint.id === endpointChoice);
  const peerUrl = selectedEndpoint?.url ?? manualUrl.trim();
  const isPeerUrlValid = isAllowedPeerUrl(peerUrl);
  const canCreate = label.trim() !== "" && projectIds.length > 0 && isPeerUrlValid && !isCreating;

  const reset = () => {
    setLabel("");
    setProjectIds([]);
    setMaxRuntimeMode("auto");
    setMaxInteractionMode("default");
    setRunSetupScripts(false);
    setEndpointId(null);
    setManualUrl("");
    setSetupString(null);
  };

  const { copyToClipboard } = useCopyToClipboard({
    onCopy: () => toastManager.add({ type: "success", title: "Setup string copied" }),
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy setup string",
          description: error.message,
        }),
      ),
  });

  const handleCreate = async () => {
    const [firstProjectId, ...otherProjectIds] = projectIds;
    if (firstProjectId === undefined || !isPeerUrlValid) return;
    setIsCreating(true);
    try {
      const created = await createServerPeerGrant({
        label: label.trim(),
        projectIds: [firstProjectId, ...otherProjectIds],
        maxRuntimeMode,
        maxInteractionMode,
        runSetupScripts,
      });
      setSetupString(encodePeerSetupString({ url: peerUrl, secret: created.secret }));
      onCreated();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create grant",
          description: errorMessage(error, "Failed to create grant."),
        }),
      );
    } finally {
      setIsCreating(false);
    }
  };

  // Every close path clears the form and the one-time setup string.
  const handleOpenChange = (next: boolean) => {
    if (isCreating) return;
    setOpen(next);
    if (!next) reset();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button size="xs" variant="default">
            <PlusIcon className="size-3" />
            New grant
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{setupString ? "Setup string" : "New peer grant"}</DialogTitle>
          <DialogDescription>
            {setupString
              ? "Paste this into the other environment's Peer environments setting. It is shown only once."
              : "Let agents in another environment start and follow threads in these projects."}
          </DialogDescription>
        </DialogHeader>
        {setupString ? (
          <>
            <DialogPanel>
              <Textarea
                readOnly
                value={setupString}
                rows={4}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
              />
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="outline" onClick={() => copyToClipboard(setupString, undefined)}>
                Copy
              </Button>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogPanel>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">Label</span>
                <Input
                  value={label}
                  maxLength={120}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="e.g. Laptop agents"
                  disabled={isCreating}
                  autoFocus
                />
              </label>
              <section className="space-y-1.5">
                <h3 className="text-xs font-medium text-foreground">Projects</h3>
                {projects.length === 0 ? (
                  <p className="text-xs text-muted-foreground">This environment has no projects.</p>
                ) : (
                  <div className="max-h-48 divide-y divide-border/60 overflow-y-auto rounded-lg border border-input bg-muted/25">
                    {projects.map((project) => (
                      <label
                        key={project.id}
                        className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40"
                      >
                        <Checkbox
                          checked={projectIds.includes(project.id)}
                          disabled={isCreating}
                          onCheckedChange={(checked) =>
                            setProjectIds((current) =>
                              checked === true
                                ? [...current, project.id]
                                : current.filter((projectId) => projectId !== project.id),
                            )
                          }
                        />
                        <span className="min-w-0 truncate text-xs text-foreground">
                          {project.title}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </section>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="mb-1.5 block text-xs font-medium text-foreground">
                    Max permissions
                  </span>
                  <Select
                    items={RUNTIME_MODE_ITEMS}
                    value={maxRuntimeMode}
                    disabled={isCreating}
                    onValueChange={(value) => {
                      if (value !== null) setMaxRuntimeMode(value);
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Max permissions">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {RUNTIME_MODE_ITEMS.map(({ value, label: itemLabel }) => (
                        <SelectItem key={value} value={value}>
                          {itemLabel}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium text-foreground">Max mode</span>
                  <Select
                    items={INTERACTION_MODE_ITEMS}
                    value={maxInteractionMode}
                    disabled={isCreating}
                    onValueChange={(value) => {
                      if (value !== null) setMaxInteractionMode(value);
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Max mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {INTERACTION_MODE_ITEMS.map(({ value, label: itemLabel }) => (
                        <SelectItem key={value} value={value}>
                          {itemLabel}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>
              <label className="flex cursor-pointer items-start gap-3">
                <Checkbox
                  className="mt-0.5"
                  checked={runSetupScripts}
                  disabled={isCreating}
                  onCheckedChange={(checked) => setRunSetupScripts(checked === true)}
                />
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-foreground">
                    Run project setup scripts
                  </span>
                  <span className="block text-xs leading-snug text-muted-foreground">
                    Setup scripts run the incoming code without permission checks.
                  </span>
                </span>
              </label>
              <div>
                <span className="mb-1.5 block text-xs font-medium text-foreground">
                  Reach this environment at
                </span>
                {peerEndpoints.options.length > 0 ? (
                  <Select
                    items={[
                      ...peerEndpoints.options.map((endpoint) => ({
                        value: endpoint.id,
                        label: endpoint.url,
                      })),
                      { value: CUSTOM_ENDPOINT, label: "Other address" },
                    ]}
                    value={endpointChoice}
                    disabled={isCreating}
                    onValueChange={setEndpointId}
                  >
                    <SelectTrigger size="sm" aria-label="Endpoint">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {peerEndpoints.options.map((endpoint) => (
                        <SelectItem key={endpoint.id} value={endpoint.id}>
                          {endpoint.label} · {endpoint.url}
                        </SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_ENDPOINT}>Other address</SelectItem>
                    </SelectPopup>
                  </Select>
                ) : null}
                {selectedEndpoint === undefined ? (
                  <div className={peerEndpoints.options.length > 0 ? "mt-2" : undefined}>
                    <Input
                      type="url"
                      aria-label="Endpoint URL"
                      value={manualUrl}
                      onChange={(event) => setManualUrl(event.target.value)}
                      placeholder="https://"
                      disabled={isCreating}
                    />
                    {manualUrl.trim() !== "" && !isPeerUrlValid ? (
                      <span className="mt-1.5 block text-xs text-destructive">
                        Use an https URL.
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button
                variant="outline"
                disabled={isCreating}
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <Button disabled={!canCreate} onClick={() => void handleCreate()}>
                {isCreating ? "Creating…" : "Create grant"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function PeerTargetsSection({ canEdit }: { readonly canEdit: boolean }) {
  const targets = usePrimaryList(listServerPeerTargets);
  const [removingId, setRemovingId] = useState<PeerTarget["environmentId"] | null>(null);

  const handleRemove = async (target: PeerTarget) => {
    // Fail closed: no mounted confirm host means no removal.
    const confirmed = await requestConfirmDialog(
      `Remove ${target.label}?\nAgents here can no longer hand work to it. Its grant stays active there until an admin revokes it.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setRemovingId(target.environmentId);
    try {
      await removeServerPeerTarget(target.environmentId);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not remove peer environment",
          description: errorMessage(error, "Failed to remove peer environment."),
        }),
      );
    } finally {
      setRemovingId(null);
      targets.refresh();
    }
  };

  const { id, title } = searchableSetting("peer-environments");
  const items = targets.items ?? [];
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={targets.items ? countLabel(items.length, "environment") : null}
      control={canEdit ? <AddPeerTargetDialog onAdded={targets.refresh} /> : null}
    >
      <ListStatusRow
        error={targets.error}
        empty={targets.items !== null && items.length === 0 ? "No peer environments." : null}
      />
      {items.map((target) => (
        <div key={target.environmentId} className={ITEM_ROW_CLASSNAME}>
          <div className={ITEM_ROW_INNER_CLASSNAME}>
            <div className="min-w-0 flex-1 space-y-1">
              <h3 className="text-sm font-medium text-foreground">{target.label}</h3>
              <p className="truncate text-xs text-muted-foreground">
                {target.grantLabel} · {target.url}
              </p>
            </div>
            {canEdit ? (
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={removingId === target.environmentId}
                onClick={() => void handleRemove(target)}
              >
                {removingId === target.environmentId ? "Removing…" : "Remove"}
              </Button>
            ) : null}
          </div>
        </div>
      ))}
    </FoldedSettingsSection>
  );
}

function AddPeerTargetDialog({ onAdded }: { readonly onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const handleAdd = async () => {
    setIsAdding(true);
    setError(null);
    try {
      const target = await addServerPeerTarget(setup.trim());
      toastManager.add({ type: "success", title: `Added ${target.label}` });
      onAdded();
      setOpen(false);
      setSetup("");
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause, "Could not add the peer environment."));
    } finally {
      setIsAdding(false);
    }
  };

  // Every close path clears the pasted secret.
  const handleOpenChange = (next: boolean) => {
    if (isAdding) return;
    setOpen(next);
    if (!next) {
      setSetup("");
      setError(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button size="xs" variant="default">
            <PlusIcon className="size-3" />
            Add
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add peer environment</DialogTitle>
          <DialogDescription>
            Paste the setup string from the other environment&apos;s Peer grants setting.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Textarea
            value={setup}
            rows={4}
            onChange={(event) => setSetup(event.target.value)}
            placeholder="t3peer1."
            disabled={isAdding}
            autoFocus
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={isAdding} onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={isAdding || setup.trim() === ""} onClick={() => void handleAdd()}>
            {isAdding ? "Checking…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
