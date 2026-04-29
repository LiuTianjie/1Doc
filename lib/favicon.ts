export function localFaviconUrl(entryUrl: string): string | null {
  try {
    const url = new URL(entryUrl);
    return `/api/favicon?url=${encodeURIComponent(url.toString())}`;
  } catch {
    return null;
  }
}
