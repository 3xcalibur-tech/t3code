import { EnvironmentId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const watchCommand = vi.hoisted(() => vi.fn());
const shell = vi.hoisted(() => ({
  relationshipToParent: null as "subagent" | null,
}));

vi.mock("./ThreadDetailsPrRow", () => ({
  ThreadDetailsPrRow: ({ trailing, menu }: { trailing?: ReactNode; menu?: ReactNode }) => (
    <div>
      <span data-trailing="">{trailing}</span>
      {menu}
    </div>
  ),
}));
vi.mock("../ui/menu", () => ({
  MenuSeparator: () => null,
  MenuItemLabel: ({ children }: { children: ReactNode }) => children,
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  MenuCheckboxItem: ({
    children,
    checked,
    onCheckedChange,
  }: {
    children: ReactNode;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    >
      {children}
    </button>
  ),
}));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ open: vi.fn() }) },
}));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({
    lineage: { relationshipToParent: shell.relationshipToParent },
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
  }),
  useServerConfigs: () =>
    new Map([["environment", { environment: { capabilities: { threadPullRequestWatch: true } } }]]),
}));
vi.mock("~/state/threads", () => ({ threadEnvironment: {} }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => watchCommand }));

import { ThreadDetailsPrRows } from "./ThreadDetailsPrRows";

const watch: NonNullable<ThreadPullRequestLink["watch"]> = {
  startedAt: "2026-01-01T00:00:30.000Z",
  headSha: null,
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: "2026-01-01T00:00:30.000Z",
  remarkIds: [],
  conflicting: false,
  wakes: 0,
};

function link(number: number, watched = false): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "pingdotgg/t3code",
    number,
    url: `https://github.com/pingdotgg/t3code/pull/${number}`,
    source: "manual",
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot: {
      state: "open",
      title: `Change ${number}`,
      headBranch: `branch-${number}`,
      baseBranch: "main",
      isDraft: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
      syncedAt: "2026-01-01T00:00:00.000Z",
    },
    stack: null,
    ...(watched ? { watch } : {}),
  };
}

let renderer: ReactTestRenderer;
afterEach(() => {
  shell.relationshipToParent = null;
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
  watchCommand.mockClear();
});

function render(links: ReadonlyArray<ThreadPullRequestLink>, current: ThreadPullRequestLink) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  act(() => {
    renderer = create(
      <ThreadDetailsPrRows
        threadRef={{
          environmentId: EnvironmentId.make("environment"),
          threadId: ThreadId.make("thread"),
        }}
        links={links}
        currentLink={current}
        environmentId={EnvironmentId.make("environment")}
        pr={null}
        number={current.number}
        reference={current}
        status={null}
        project={null}
        label={`#${current.number}`}
        openAriaLabel="Open pull request"
        url={current.url}
        onOpen={vi.fn()}
      />,
    );
  });
}

const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
const trailing = () => text(renderer.root.findByProps({ "data-trailing": "" }));
const switches = () =>
  renderer.root
    .findAll((node) => node.type === "button" && node.props.role === "switch")
    .map((node) => [text(node), node.props["aria-checked"]]);
const button = (label: string) =>
  renderer.root.findAll((node) => node.type === "button" && text(node) === label)[0]!;

it("has a switch for the current pull request and each monitored one, not unmonitored others", () => {
  render([link(1), link(2, true), link(3, true), link(4)], link(1));
  expect(switches()).toEqual([
    ["Monitor #1", false],
    ["Monitor #2", true],
    ["Monitor #3", true],
  ]);
  expect(trailing()).toBe("Monitoring");
  expect(button("All linked PRs")).toBeDefined();
});

it("labels a lone switch Monitor and toggles the watch both ways", () => {
  render([link(1, true)], link(1, true));
  expect(switches()).toEqual([["Monitor", true]]);
  expect(renderer.root.findAll((node) => text(node) === "All linked PRs")).toHaveLength(0);

  act(() => button("Monitor").props.onClick());
  expect(watchCommand).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("environment"),
    input: {
      threadId: ThreadId.make("thread"),
      host: "github.com",
      repository: "pingdotgg/t3code",
      number: 1,
      watching: false,
    },
  });
});

it("shows nothing at the row's end when nothing is monitored", () => {
  render([link(1)], link(1));
  expect(trailing()).toBe("");
});

it("offers no way to start monitoring from a subagent, which its parent does for it", () => {
  shell.relationshipToParent = "subagent";
  render([link(1), link(2, true)], link(1));
  expect(switches()).toEqual([["Monitor #2", true]]);
});
