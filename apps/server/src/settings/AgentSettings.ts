/**
 * AgentSettings - Server settings and keybindings as agents read and change them.
 *
 * Wraps the settings and keybindings services with the rules agents follow: credentials are
 * redacted on read and rejected on write, and one update changes either settings or one
 * keybinding.
 *
 * @module AgentSettings
 */
import {
  type KeybindingsConfigError,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
  ServerRemoveKeybindingInput,
  ServerSettings,
  type ServerSettingsError,
  ServerSettingsPatch,
  ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Keybindings from "../keybindings.ts";
import * as Settings from "../serverSettings.ts";

export class InvalidPreferencesInputError extends Schema.TaggedError<InvalidPreferencesInputError>()(
  "InvalidPreferencesInputError",
  {
    input: Schema.Literals(["settings", "keybinding"]),
    cause: Schema.instanceOf(Schema.SchemaError),
  },
) {
  override get message(): string {
    return `Invalid ${this.input}.`;
  }
}

export class CredentialSettingsRejectedError extends Schema.TaggedError<CredentialSettingsRejectedError>()(
  "CredentialSettingsRejectedError",
  { keys: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `These settings hold or carry credentials and can only be changed in the Settings UI: ${this.keys.join(", ")}.`;
  }
}

export class DuplicatedPreferenceFieldsError extends Schema.TaggedError<DuplicatedPreferenceFieldsError>()(
  "DuplicatedPreferenceFieldsError",
  { keys: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Pass ${this.keys.join(", ")} at the top level or inside settings, not both.`;
  }
}

export class ConflictingProviderChangeError extends Schema.TaggedError<ConflictingProviderChangeError>()(
  "ConflictingProviderChangeError",
  {},
) {
  override get message(): string {
    return "Pass providerInstance or settings.providers, not both.";
  }
}

export class MixedSettingsAndKeybindingError extends Schema.TaggedError<MixedSettingsAndKeybindingError>()(
  "MixedSettingsAndKeybindingError",
  {},
) {
  override get message(): string {
    return "Change settings and a keybinding in separate calls.";
  }
}

/** A keybinding rule as key/command/when text, the shape the Settings UI shows. */
export interface KeybindingRuleText {
  readonly key: string;
  readonly command: string;
  readonly when: string | null;
}

interface KeybindingTarget {
  readonly key: string;
  readonly command: string;
  readonly when?: string | null | undefined;
}

export class AgentSettings extends Context.Service<
  AgentSettings,
  {
    /** Current settings, plus redacted full settings and keybinding texts when asked for. */
    readonly read: (include: {
      readonly settings: boolean;
      readonly keybindings: boolean;
    }) => Effect.Effect<
      {
        readonly current: ServerSettings;
        readonly settings?: Record<string, unknown>;
        readonly keybindings?: ReadonlyArray<KeybindingRuleText>;
      },
      ServerSettingsError | KeybindingsConfigError | Schema.SchemaError
    >;

    /**
     * Validate every part of the change, then persist settings or one keybinding rule.
     * `fields` are top-level preference fields; `settings` is an undecoded settings patch.
     */
    readonly update: (change: {
      readonly fields: ServerSettingsPatch;
      readonly settings?: unknown;
      readonly providerInstance?: Settings.ProviderInstancePreferences | undefined;
      readonly keybinding?:
        | (KeybindingTarget & {
            readonly action: "upsert" | "remove";
            readonly replace?: KeybindingTarget | undefined;
          })
        | undefined;
    }) => Effect.Effect<
      {
        readonly next: ServerSettings;
        readonly updated: ReadonlyArray<string>;
        /** The command's effective rules after a keybinding change. */
        readonly keybindings?: ReadonlyArray<KeybindingRuleText>;
      },
      | InvalidPreferencesInputError
      | CredentialSettingsRejectedError
      | DuplicatedPreferenceFieldsError
      | ConflictingProviderChangeError
      | Settings.ProviderInstanceConfigNotObjectError
      | Settings.ProviderInstanceNotFoundError
      | MixedSettingsAndKeybindingError
      | ServerSettingsError
      | KeybindingsConfigError
    >;
  }
>()("t3/settings/AgentSettings") {}

// The settings service's own redaction marker.
const SECRET_MARKER = "•".repeat(6);
// Provider form fields with a "password" control. Clients receive them in plain text; agents do not.
const PLAINTEXT_SECRET_KEYS = new Set(["apiKey", "serverPassword"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const mapRecord = (value: unknown, f: (entry: unknown) => unknown) =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, f(v)])) : value;
const encodeSettings = Schema.encodeEffect(ServerSettings);

/** Full server settings as JSON with every credential redacted. */
export const redactSettingsForAgent = (settings: ServerSettings) =>
  encodeSettings(Settings.redactServerSettingsForClient(settings)).pipe(
    Effect.map((encoded) =>
      withoutUrlCredentialsIn({
        ...encoded,
        providers: mapRecord(encoded.providers, redactSecretFields),
        // Instance configs are opaque driver data that can nest credentials anywhere; only the
        // custom models agents can change are returned.
        providerInstances: mapRecord(encoded.providerInstances, (instance) =>
          isRecord(instance) && "config" in instance
            ? {
                ...instance,
                config:
                  isRecord(instance.config) && Array.isArray(instance.config.customModels)
                    ? { customModels: instance.config.customModels }
                    : {},
              }
            : instance,
        ),
      }),
    ),
  );
// A URL can carry credentials in its userinfo or query; only the origin and path are kept.
function withoutUrlCredentials(value: string) {
  if (!URL.canParse(value)) return value;
  const url = new URL(value);
  if (url.username === "" && url.password === "" && url.search === "" && url.hash === "")
    return value;
  return `${url.origin}${url.pathname}`;
}
// Includes Cursor's legacy endpoint, which predates the Url naming convention.
const isUrlSetting = (key: string) =>
  key.endsWith("Url") || key.endsWith("url") || key === "apiEndpoint";
function withoutUrlCredentialsIn(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, field]) => [
      key,
      typeof field === "string" && isUrlSetting(key)
        ? withoutUrlCredentials(field)
        : withoutUrlCredentialsDeep(field),
    ]),
  );
}
function withoutUrlCredentialsDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUrlCredentialsDeep);
  return isRecord(value) ? withoutUrlCredentialsIn(value) : value;
}
function redactSecretFields(config: unknown) {
  if (!isRecord(config)) return config;
  return Object.fromEntries(
    Object.entries(config).map(([key, field]) => [
      key,
      PLAINTEXT_SECRET_KEYS.has(key) && typeof field === "string" && field.length > 0
        ? SECRET_MARKER
        : field,
    ]),
  );
}

// Credentials, and the maps that carry them, stay in the Settings UI. deviceHosts needs the SSH
// host preparation ws.ts runs before saving.
const REJECTED_PATCH_KEYS = [
  "bitbucket",
  "usageLimitSources",
  "cursorKeychainUsageEnabled",
  "providerInstances",
  "deviceHosts",
] as const;
function rejectedPatchKeys(patch: ServerSettingsPatch) {
  const endpoints = [
    ["providers.opencode.serverUrl", patch.providers?.opencode?.serverUrl],
    ["observability.otlpTracesUrl", patch.observability?.otlpTracesUrl],
    ["observability.otlpMetricsUrl", patch.observability?.otlpMetricsUrl],
    ["observability.otlpLogsUrl", patch.observability?.otlpLogsUrl],
  ] as const;
  return [
    ...REJECTED_PATCH_KEYS.filter((key) => patch[key] !== undefined),
    ...(patch.providers?.antigravity?.apiKey === undefined ? [] : ["providers.antigravity.apiKey"]),
    ...(patch.providers?.opencode?.serverPassword === undefined
      ? []
      : ["providers.opencode.serverPassword"]),
    ...endpoints.flatMap(([key, value]) =>
      value !== undefined && withoutUrlCredentials(value) !== value ? [key] : [],
    ),
  ];
}
const strict = { onExcessProperty: "error" } as const;
const decodePatch = (input: unknown) =>
  Schema.decodeUnknownEffect(ServerSettingsPatch)(input, strict).pipe(
    Effect.mapError((cause) => new InvalidPreferencesInputError({ input: "settings", cause })),
  );
const withoutNullWhen = <T extends { readonly when?: string | null | undefined }>({
  when,
  ...rest
}: T) => (when === null || when === undefined ? rest : { ...rest, when });
const decodeUpsert = (input: unknown) =>
  Schema.decodeUnknownEffect(ServerUpsertKeybindingInput)(input, strict).pipe(
    Effect.mapError((cause) => new InvalidPreferencesInputError({ input: "keybinding", cause })),
  );
const decodeRemove = (input: unknown) =>
  Schema.decodeUnknownEffect(ServerRemoveKeybindingInput)(input, strict).pipe(
    Effect.mapError((cause) => new InvalidPreferencesInputError({ input: "keybinding", cause })),
  );

// The Settings UI's when text; the keybindings service matches when by meaning, so a listed
// rule can be removed by the same text.
function whenText(node: KeybindingWhenNode): string {
  const wrap = (child: KeybindingWhenNode) =>
    child.type === "identifier" || child.type === "not" || child.type === node.type
      ? whenText(child)
      : `(${whenText(child)})`;
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${wrap(node.node)}`;
    case "and":
      return `${wrap(node.left)} && ${wrap(node.right)}`;
    case "or":
      return `${wrap(node.left)} || ${wrap(node.right)}`;
  }
}
const encodeKeybinding = Schema.encodeExit(Keybindings.ResolvedKeybindingFromConfig);
function keybindingTexts(rules: ResolvedKeybindingsConfig): ReadonlyArray<KeybindingRuleText> {
  return rules.flatMap((rule) => {
    const encoded = encodeKeybinding(rule);
    return Exit.isSuccess(encoded)
      ? [
          {
            key: encoded.value.key,
            command: rule.command,
            when: rule.whenAst ? whenText(rule.whenAst) : null,
          },
        ]
      : [];
  });
}

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const keybindingService = yield* Keybindings.Keybindings;

  const read: AgentSettings["Service"]["read"] = (include) =>
    Effect.gen(function* () {
      const current = yield* settings.getSettings;
      const keybindings = include.keybindings
        ? yield* keybindingService.loadConfigState
        : undefined;
      return {
        current,
        ...(include.settings ? { settings: yield* redactSettingsForAgent(current) } : {}),
        ...(keybindings ? { keybindings: keybindingTexts(keybindings.keybindings) } : {}),
      };
    });

  const update: AgentSettings["Service"]["update"] = ({
    fields,
    settings: settingsInput,
    providerInstance,
    keybinding,
  }) =>
    Effect.gen(function* () {
      // Validate everything before the first write.
      const extra = settingsInput === undefined ? {} : yield* decodePatch(settingsInput);
      const rejected = rejectedPatchKeys(extra);
      if (rejected.length > 0)
        return yield* new CredentialSettingsRejectedError({ keys: rejected });
      const duplicated = Object.keys(fields).filter((key) => Object.hasOwn(extra, key));
      if (duplicated.length > 0)
        return yield* new DuplicatedPreferenceFieldsError({ keys: duplicated });
      if (providerInstance && extra.providers) return yield* new ConflictingProviderChangeError();
      const { action, ...listed } = keybinding ?? { action: undefined };
      // Listed rules carry when: null; the keybinding contracts expect it omitted.
      const rule = {
        ...withoutNullWhen(listed),
        ...("replace" in listed && listed.replace
          ? { replace: withoutNullWhen(listed.replace) }
          : {}),
      };
      const keybindingInput =
        action === "upsert"
          ? yield* decodeUpsert(rule)
          : action === "remove"
            ? yield* decodeRemove(rule)
            : undefined;
      const patch: ServerSettingsPatch = { ...extra, ...fields };
      // Settings and keybindings persist separately, so one call changes one of them.
      if (
        keybinding !== undefined &&
        (providerInstance !== undefined || Object.keys(patch).length > 0)
      )
        return yield* new MixedSettingsAndKeybindingError();

      const next = yield* providerInstance !== undefined
        ? settings.updateProviderInstancePreferences(providerInstance, patch)
        : keybinding === undefined
          ? settings.updateSettings(patch)
          : settings.getSettings;
      const keybindings =
        keybindingInput === undefined
          ? undefined
          : yield* action === "upsert"
              ? keybindingService.upsertKeybindingRule(keybindingInput)
              : keybindingService.removeKeybindingRule(keybindingInput);
      return {
        next,
        updated: [
          ...Object.keys({ ...extra, ...fields }),
          ...(providerInstance ? [`providerInstance:${providerInstance.instanceId}`] : []),
          ...(action ? [`keybinding:${action}`] : []),
        ],
        ...(keybindings && keybindingInput
          ? {
              keybindings: keybindingTexts(
                keybindings.filter((entry) => entry.command === keybindingInput.command),
              ),
            }
          : {}),
      };
    });

  return AgentSettings.of({ read, update });
});

export const layer = Layer.effect(AgentSettings, make);
