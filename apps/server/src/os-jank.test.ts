import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeOS from "node:os";
import { it } from "vite-plus/test";

import { fixPath, hydratePosixHome } from "./os-jank.ts";

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});

const textEncoder = new TextEncoder();

// Answers every login shell probe from `shells`; a shell it does not list fails
// to start. Returns the shells that were launched, in order.
const runFixPath = (input: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly shells: Readonly<Record<string, string>>;
  readonly shellEnvironmentPrepared?: boolean;
}) =>
  Effect.gen(function* () {
    const launched: Array<string> = [];
    const layerSpawner = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return Effect.die("unexpected command");
        launched.push(command.command);
        const output = input.shells[command.command];
        if (output === undefined) {
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "ENOENT",
            }),
          );
        }
        const stdout = Stream.make(textEncoder.encode(output));
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            stdout,
            stderr: Stream.empty,
            all: stdout,
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        );
      }),
    );
    yield* fixPath({ shellEnvironmentPrepared: input.shellEnvironmentPrepared }).pipe(
      Effect.provideService(HostProcessPlatform, input.platform),
      Effect.provideService(HostProcessEnvironment, input.env),
      Effect.provide(Layer.mergeAll(NodeServices.layer, layerSpawner)),
    );
    return launched;
  });

const shellPathOutput = (path: string) =>
  `__T3CODE_ENV_PATH_START__\n${path}\n__T3CODE_ENV_PATH_END__\n`;

effectIt.effect("merges the login shell PATH when the environment was not prepared", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", HOME: "/home/test", PATH: "/usr/bin" };

    const launched = yield* runFixPath({
      platform: "linux",
      env,
      shells: { "/bin/zsh": shellPathOutput("/opt/tools/bin:/usr/bin") },
    });

    assert.deepEqual(launched, ["/bin/zsh"]);
    assert.equal(env.PATH, "/opt/tools/bin:/usr/bin");
  }),
);

effectIt.effect("tries the next login shell when one fails to start", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/missing", HOME: "/home/test", PATH: "/usr/bin" };

    const launched = yield* runFixPath({
      platform: "linux",
      env,
      shells: { "/bin/bash": shellPathOutput("/opt/tools/bin") },
    });

    assert.equal(launched[0], "/bin/missing");
    assert.equal(launched.at(-1), "/bin/bash");
    assert.equal(env.PATH, "/opt/tools/bin:/usr/bin");
  }),
);

effectIt.effect("keeps the inherited PATH when every login shell fails", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/missing", HOME: "/home/test", PATH: "/usr/bin" };

    yield* runFixPath({ platform: "linux", env, shells: {} });

    assert.equal(env.PATH, "/usr/bin");
  }),
);

effectIt.effect("skips every shell probe when the desktop prepared the environment", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/prepared/bin:/usr/bin" };

    const launched = yield* runFixPath({
      platform: "darwin",
      env,
      shells: { "/bin/zsh": shellPathOutput("/other/bin") },
      shellEnvironmentPrepared: true,
    });

    assert.deepEqual(launched, []);
    assert.equal(env.PATH, "/prepared/bin:/usr/bin");
    // HOME is not part of what the desktop prepares, so it is still filled in.
    assert.equal(env.HOME, NodeOS.userInfo().homedir);
  }),
);
