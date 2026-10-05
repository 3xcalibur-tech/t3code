export {
  getPrimaryKnownEnvironment,
  resetPrimaryEnvironmentDescriptorForTests,
  resolveInitialPrimaryEnvironmentDescriptor,
  writePrimaryEnvironmentDescriptor,
} from "./context";

export {
  addServerPeerTarget,
  createServerPairingCredential,
  createServerPeerGrant,
  isPrimaryEnvironmentPairingCredentialRejectedError,
  listServerPeerGrants,
  listServerPeerTargets,
  removeServerPeerTarget,
  revokeServerPeerGrant,
  peekPairingTokenFromUrl,
  PrimaryEnvironmentPairingCredentialRejectedError,
  PrimaryEnvironmentRequestError,
  resolveInitialServerAuthGateState,
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
  takePairingTokenFromUrl,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
  __resetServerAuthBootstrapForTests,
} from "./auth";

export { usePrimarySessionState } from "./sessionState";

export {
  DesktopEnvironmentBootstrapIncompleteError,
  isDesktopEnvironmentBootstrapIncompleteError,
  isPrimaryEnvironmentProtocolUnsupportedError,
  isPrimaryEnvironmentUrlInvalidError,
  PrimaryEnvironmentProtocolUnsupportedError,
  PrimaryEnvironmentUrlInvalidError,
  readPrimaryEnvironmentTarget,
  resolvePrimaryEnvironmentHttpUrl,
  isLoopbackHostname,
  type PrimaryEnvironmentTarget,
} from "./target";
