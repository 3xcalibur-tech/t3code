# Peer access

Peer access lets agents in one environment (A) start and follow threads in
another environment (B) through the `t3_peer_*` MCP tools. Setup is once per
pair: an admin on B creates a grant, and a user pastes its setup string into A.
See [remote access](../user/remote-access.md#peer-access) for the user flow.

## Why it is not ordinary pairing

A paired client session would be the wrong tool in three ways:

- The approver must be an admin of B. Creating a grant needs `access:write` on
  B, which relay-minted and standard sessions do not have.
- `orchestration:operate` covers settings, provider installs, file writes, and
  more. A grant can only start threads in its projects, read and wait on them,
  and interrupt them.
- A revoked session keeps an open WebSocket. The
  [peer API](../../apps/server/src/peer/http.ts) is HTTP only, looks the grant
  up on every request, and caps a wait at 30 seconds, so a revoke applies to
  the next call. Threads that already started keep running.

The grant is the identity. A bearer secret cannot prove which environment holds
it, so the environment id A sends is a display hint marked as not verified.
B stores only a hash of the secret. A keeps its targets, secrets included, in
its server secret store.

## Provenance is the boundary

Work a grant starts carries `peerOrigin` on the thread record. It is immutable,
and every thread created from peer work inherits it: subagents and forks copy
the parent thread, and launches, `create_threads`, and scheduled runs pass it
explicitly. A client cannot set or clear it on `thread.create`. Scheduled tasks
record it at creation and keep it on every edit.

[Peer-origin rules](../../apps/server/src/mcp/peerOrigin.ts) apply in the
shared MCP helpers, not in the tool list:

- Peer work may only act on work from the same grant. Grants differ in modes
  and setup-script permission, so one grant's work must not steer another's.
- Peer work may read shared state and use shared resources such as devices and
  the preview browser, but it cannot change project or environment settings,
  launch outside its grant's projects, or reach any other environment.
- A peer scheduled task runs only while its grant is active, and only into
  peer-origin threads.

Project setup scripts run the incoming commit's code outside provider permission
checks. The [setup runner](../../apps/server/src/project/ProjectSetupScriptRunner.ts)
skips them for peer work unless the grant allows them and is still active. The
check is in the runner, so every setup path, including worktree handoff, obeys
it.

This is an MCP routing policy, not credential isolation. Any agent on B runs as
B's OS user and can read what that user can read. A grant limits what the API
and MCP do, not what an agent can read on its own machine.

## Launches are exact and repeatable

A launch names a branch on B's remote and a full commit. B fetches the branch
and starts a fresh worktree at that commit only if the commit is on that remote
branch. It never falls back to a local ref, so A must push first.

The thread, message, and command ids derive from the grant and the request key,
which A scopes to the calling thread. A retried launch finds the accepted thread
before it repeats any git or provider checks.
