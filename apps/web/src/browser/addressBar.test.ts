import { describe, expect, it } from "vite-plus/test";

import { resolveAddressBarInput } from "./addressBar";

describe("resolveAddressBarInput", () => {
  it.each(["hello there", "hello", "  how does React work?  ", "C++ & TypeScript", "日本語 検索"])(
    "searches Google for %j",
    (input) => {
      const url = new URL(resolveAddressBarInput(input));
      expect(url.origin + url.pathname).toBe("https://www.google.com/search");
      expect(url.searchParams.get("q")).toBe(input.trim());
    },
  );

  it.each([
    ["example.com", "https://example.com/"],
    ["example.com/a path?q=hello there", "https://example.com/a%20path?q=hello%20there"],
    ["https://example.com/path?q=1", "https://example.com/path?q=1"],
    ["http://intranet/docs", "http://intranet/docs"],
    ["localhost:3000", "http://localhost:3000/"],
    ["127.0.0.1:5173", "http://127.0.0.1:5173/"],
    ["[::1]:3000", "http://[::1]:3000/"],
    ["192.168.1.10", "https://192.168.1.10/"],
    ["devbox:3000", "https://devbox:3000/"],
  ])("navigates directly to %s", (input, expected) => {
    expect(resolveAddressBarInput(input)).toBe(expected);
  });

  it("keeps empty input and unsupported explicit URLs invalid", () => {
    expect(() => resolveAddressBarInput("   ")).toThrow();
    expect(() => resolveAddressBarInput("file:///etc/hosts")).toThrow();
  });
});
