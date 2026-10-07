// @effect-diagnostics globalTimers:off - Ceremonies settle inside IPC handlers, outside an Effect runtime.
import type { IpcMainInvokeEvent, Session, WebContents, WebFrameMain } from "electron";
import { app, BrowserWindow, dialog, webContents as electronWebContents } from "electron";
import type { WebauthnGetRequestOptions } from "electron-webauthn";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { getPublicSuffix } from "tldts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { PASSKEY_CREATE_CHANNEL, PASSKEY_GET_CHANNEL } from "./GuestProtocol.ts";
import { authenticatorDataFromAttestation } from "./PasskeyAttestation.ts";
import type { PasskeyCeremonyResult } from "./PasskeyBridge.ts";

const PasskeyPackageMetadata = Schema.Struct({
  t3codeWebAuthn: Schema.optional(
    Schema.Struct({
      touchIdKeychainAccessGroup: Schema.optional(Schema.String),
      browserPasskeys: Schema.optional(Schema.Boolean),
    }),
  ),
});
const decodePasskeyPackageMetadata = Schema.decodeEffect(
  Schema.fromJsonString(PasskeyPackageMetadata),
);

export class PreviewPasskeysConfigureError extends Schema.TaggedError<PreviewPasskeysConfigureError>()(
  "PreviewPasskeysConfigureError",
  {
    keychainAccessGroup: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to enable Touch ID passkeys for the in-app browser (keychain group ${this.keychainAccessGroup}).`;
  }
}

/**
 * Passkeys for in-app browser pages on macOS, where Electron has no WebAuthn UI
 * of its own. Signed builds record which entitlements their provisioning
 * profile granted (scripts/build-desktop-artifact.ts), and each path turns on
 * only when its entitlement is present:
 *
 * - Touch ID: Electron's built-in platform authenticator. Passkeys it creates
 *   stay on this Mac, in T3 Code's keychain group.
 * - Browser passkeys: Apple's managed browser entitlement lets the system sheet
 *   (iCloud Keychain, password managers, phones, security keys) serve any
 *   site. The guest preload hands each ceremony to this process, which pins
 *   the requesting frame's real origin.
 *
 * Windows needs neither: Chromium already uses Windows Hello there.
 */
export class PreviewPasskeys extends Context.Service<
  PreviewPasskeys,
  {
    /** Whether preview pages route WebAuthn through the system passkey sheet. */
    readonly bridgeEnabled: boolean;
    /** Turns on Touch ID passkeys when this build is entitled to them. Runs after app ready. */
    readonly configure: Effect.Effect<void>;
    /** Lets the user choose between several passkeys for one site. Idempotent. */
    readonly installSessionHandlers: (session: Session) => void;
    /** Serves a preview guest's passkey ceremonies. Returns the detach function. */
    readonly attachGuest: (guest: WebContents) => () => void;
  }
>()("@t3tools/desktop/preview/Passkeys/PreviewPasskeys") {}

const notAllowed: PasskeyCeremonyResult = { success: false, error: "NotAllowedError" };

// WebAuthn rejects RP IDs that are public suffixes, private registries
// included, so one github.io site cannot mint passkeys for every other one.
const isPublicSuffix = (domain: string) =>
  domain !== "localhost" && getPublicSuffix(domain, { allowPrivateDomains: true }) === domain;

const accountLabel = (account: Electron.WebAuthnAccount) =>
  account.displayName && account.name && account.displayName !== account.name
    ? `${account.displayName} (${account.name})`
    : (account.name ?? account.displayName ?? "Unnamed passkey");

const ownerWindow = (frame: WebFrameMain | null) => {
  const contents = frame ? electronWebContents.fromFrame(frame) : undefined;
  const owner = contents?.hostWebContents ?? contents;
  return owner ? BrowserWindow.fromWebContents(owner) : null;
};

const chooseAccount = async (details: Electron.SelectWebauthnAccountDetails) => {
  const [onlyAccount] = details.accounts;
  // The Touch ID prompt that follows already asks the user to confirm.
  if (details.accounts.length === 1) return onlyAccount?.credentialId;
  const options: Electron.MessageBoxOptions = {
    type: "none",
    message: "Choose a passkey",
    detail: details.relyingPartyId,
    buttons: [...details.accounts.map(accountLabel), "Cancel"],
    cancelId: details.accounts.length,
    defaultId: 0,
    noLink: true,
  };
  const parent = ownerWindow(details.frame);
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return details.accounts[response]?.credentialId;
};

type WebAuthn = typeof import("electron-webauthn");
type Ceremony = (
  webauthn: WebAuthn,
  options: WebauthnGetRequestOptions,
) => Promise<PasskeyCeremonyResult>;

const ES256 = -7;
const NATIVE_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const NATIVE_MAX_TIMEOUT_MS = 60 * 60 * 1000;

// Mirrors the native layer's own clamp, plus a margin: it can leave a ceremony
// unsettled, and the page must still get an answer.
const ceremonyDeadline = (timeout: unknown) =>
  (typeof timeout === "number" && timeout > 0
    ? Math.min(timeout, NATIVE_MAX_TIMEOUT_MS)
    : NATIVE_DEFAULT_TIMEOUT_MS) + 5_000;

const withDeadline = (ceremony: Promise<PasskeyCeremonyResult>, milliseconds: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<PasskeyCeremonyResult>((resolve) => {
    timer = setTimeout(() => resolve(notAllowed), milliseconds);
  });
  return Promise.race([ceremony, deadline]).finally(() => clearTimeout(timer));
};

// Secure contexts only, as in Chromium: https, or http on this machine.
const isTrustworthyOrigin = (origin: string) => {
  if (!URL.canParse(origin)) return false;
  const { protocol, hostname } = new URL(origin);
  return (
    protocol === "https:" ||
    (protocol === "http:" &&
      (hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname === "127.0.0.1" ||
        hostname === "[::1]"))
  );
};

const createCeremony =
  (publicKey: PublicKeyCredentialCreationOptions): Ceremony =>
  async (webauthn, options) => {
    // The native layer only converts P-256 keys and never settles for any
    // other algorithm, so ES256 is the only one it may negotiate.
    const params: unknown = publicKey.pubKeyCredParams;
    const allowsEs256 =
      !Array.isArray(params) ||
      params.length === 0 ||
      params.some(
        (param: unknown) =>
          typeof param === "object" && param !== null && "alg" in param && param.alg === ES256,
      );
    if (!allowsEs256) return { success: false, error: "NotSupportedError" };
    const result = await webauthn.createCredential(
      { ...publicKey, pubKeyCredParams: [{ type: "public-key", alg: ES256 }] },
      options,
    );
    if (!result.success) return { success: false, error: result.error };
    // The native layer reports parsed authenticator data as JSON and claims
    // every credential is a synced platform passkey; neither is reliable.
    const authData = authenticatorDataFromAttestation(
      Buffer.from(result.data.attestationObject, "base64url"),
    );
    return {
      success: true,
      data: {
        ...result.data,
        authData: authData ? Buffer.from(authData).toString("base64url") : "",
        transports: [],
      },
    };
  };

const getCeremony =
  (publicKey: PublicKeyCredentialRequestOptions, origin: string): Ceremony =>
  async (webauthn, options) => {
    // WebAuthn defaults the RP ID to the caller's host; the native layer requires it.
    const result = await webauthn.getCredential(
      { ...publicKey, rpId: publicKey.rpId ?? new URL(origin).hostname },
      options,
    );
    return result.success ? result : { success: false, error: result.error };
  };

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;

  const metadata =
    environment.platform === "darwin" && environment.isPackaged
      ? yield* fileSystem
          .readFileString(environment.path.join(environment.appRoot, "package.json"))
          .pipe(
            Effect.flatMap(decodePasskeyPackageMetadata),
            Effect.map((parsed) => parsed.t3codeWebAuthn),
            Effect.orElseSucceed(() => undefined),
          )
      : undefined;
  const keychainAccessGroup = metadata?.touchIdKeychainAccessGroup;
  const bridgeEnabled = metadata?.browserPasskeys === true;
  const sessionsWithHandlers = new WeakSet<Session>();

  return PreviewPasskeys.of({
    bridgeEnabled,
    configure: Effect.gen(function* () {
      if (keychainAccessGroup === undefined) return;
      yield* Effect.try({
        try: () => app.configureWebAuthn({ touchID: { keychainAccessGroup } }),
        catch: (cause) => new PreviewPasskeysConfigureError({ keychainAccessGroup, cause }),
      }).pipe(Effect.catch((error) => Effect.logWarning(error.message, { cause: error.cause })));
    }).pipe(Effect.withSpan("desktop.previewPasskeys.configure")),
    installSessionHandlers: (session) => {
      if (sessionsWithHandlers.has(session)) return;
      sessionsWithHandlers.add(session);
      session.on("select-webauthn-account", (_event, details, callback) => {
        // The request stays pending until the callback runs, so it must run once.
        void chooseAccount(details).then(
          (credentialId) => callback(credentialId),
          () => callback(),
        );
      });
    },
    attachGuest: (guest) => {
      if (!bridgeEnabled) return () => {};
      let ceremonyPending = false;
      const serve = async (
        event: IpcMainInvokeEvent,
        publicKey: { readonly timeout?: unknown } | undefined,
        ceremony: (origin: string) => Ceremony,
      ): Promise<PasskeyCeremonyResult> => {
        // Only the guest's main frame runs the bridge preload.
        const frame = event.senderFrame;
        if (!frame || frame !== guest.mainFrame) return notAllowed;
        // The page shares a JS world with the preload, so nothing it sends can
        // be trusted for the origin. Read the committed origin before any await:
        // the frame object outlives a navigation.
        const origin = frame.origin;
        // Like Chromium, only a focused page may open the sheet, one at a time.
        if (!isTrustworthyOrigin(origin) || ceremonyPending || !guest.isFocused()) {
          return notAllowed;
        }
        if (typeof publicKey !== "object" || publicKey === null) {
          return { success: false, error: "TypeError" };
        }
        const host = guest.hostWebContents
          ? BrowserWindow.fromWebContents(guest.hostWebContents)
          : null;
        if (!host || host.isDestroyed()) return notAllowed;

        ceremonyPending = true;
        try {
          const webauthn = await import("electron-webauthn");
          const result = await withDeadline(
            ceremony(origin)(webauthn, {
              currentOrigin: origin,
              topFrameOrigin: origin,
              nativeWindowHandle: host.getNativeWindowHandle(),
              isPublicSuffix,
            }),
            ceremonyDeadline(publicKey.timeout),
          );
          // A credential minted for a document that navigated away belongs to nobody.
          const sameDocument =
            !frame.isDestroyed() && frame === guest.mainFrame && frame.origin === origin;
          return sameDocument ? result : notAllowed;
        } catch {
          return notAllowed;
        } finally {
          ceremonyPending = false;
        }
      };
      const detach = () => {
        guest.ipc.removeHandler(PASSKEY_CREATE_CHANNEL);
        guest.ipc.removeHandler(PASSKEY_GET_CHANNEL);
      };
      detach();
      // Option shapes are the page's to get wrong: the native layer validates
      // them and answers with a TypeError.
      guest.ipc.handle(
        PASSKEY_CREATE_CHANNEL,
        (event, publicKey: PublicKeyCredentialCreationOptions) =>
          serve(event, publicKey, () => createCeremony(publicKey)),
      );
      guest.ipc.handle(PASSKEY_GET_CHANNEL, (event, publicKey: PublicKeyCredentialRequestOptions) =>
        serve(event, publicKey, (origin) => getCeremony(publicKey, origin)),
      );
      return detach;
    },
  });
}).pipe(Effect.withSpan("PreviewPasskeys.make"));

export const layer = Layer.effect(PreviewPasskeys, make);
