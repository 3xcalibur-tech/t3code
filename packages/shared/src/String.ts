export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength)}...`;
}

/** Lowercases A-Z only, like SQLite's `lower()`, so server and client agree on matches. */
export function foldAsciiCase(text: string): string {
  return text.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/** Start offsets of each non-overlapping, ASCII case-insensitive occurrence of `query`. */
export function findTextOccurrences(text: string, query: string): number[] {
  const needle = foldAsciiCase(query);
  if (needle.length === 0) return [];
  const haystack = foldAsciiCase(text);
  const offsets: number[] = [];
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    offsets.push(at);
  }
  return offsets;
}
