import { normalizePreviewUrl } from "@t3tools/shared/preview";

/** Resolve address-bar input without changing URL-only navigation used by agents. */
export function resolveAddressBarInput(input: string): string {
  const text = input.trim();
  if (!text || /^[a-z][a-z\d+.-]*:\/\//i.test(text)) return normalizePreviewUrl(text);

  const authority = text.split(/[/?#]/, 1)[0] ?? "";
  const looksLikeAddress =
    !/\s/.test(authority) &&
    (authority.includes(".") ||
      /^localhost(?::\d+)?$/i.test(authority) ||
      /^\[[\da-f:]+\](?::\d+)?$/i.test(authority) ||
      /^[\w-]+:\d+$/.test(authority));

  if (looksLikeAddress) return normalizePreviewUrl(text);

  const search = new URL("https://www.google.com/search");
  search.searchParams.set("q", text);
  return search.href;
}
