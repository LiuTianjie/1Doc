import { sha256 } from "../hash";
import { normalizeUserUrl } from "../url";

const DEFAULT_PAGE_LIMIT = 300;
const MAX_PAGE_LIMIT = 1000;
const HTML_EXTENSIONS_TO_SKIP = new Set([
  ".7z",
  ".avi",
  ".css",
  ".csv",
  ".doc",
  ".docx",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".svg",
  ".tar",
  ".tgz",
  ".webm",
  ".webp",
  ".xls",
  ".xlsx",
  ".xml",
  ".zip"
]);

export function normalizeTargetLangs(values: string[]): string[] {
  const langs = values
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(value));

  return [...new Set(langs)].slice(0, 8);
}

export function normalizePageLimit(value: number | undefined): number {
  if (!value || Number.isNaN(value)) {
    return DEFAULT_PAGE_LIMIT;
  }

  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(value)));
}

export function rootUrlFor(entryUrl: string): string {
  const url = normalizeUserUrl(entryUrl);
  return url.origin;
}

export function mirrorPathFor(urlValue: string): string {
  const url = normalizeUserUrl(urlValue);
  return normalizeMirrorPath(url.pathname);
}

export function normalizeMirrorPath(pathValue: string): string {
  const withSlash = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
  const normalized = withSlash.replace(/\/{2,}/g, "/") || "/";
  return normalized.endsWith("/") && normalized !== "/" ? normalized.slice(0, -1) : normalized;
}

function decodePath(value: string): string | null {
  try {
    return decodeURI(value);
  } catch {
    return null;
  }
}

function encodePath(value: string): string | null {
  try {
    return value
      .split("/")
      .map((part) => (part ? encodeURIComponent(decodeURIComponent(part)) : part))
      .join("/");
  } catch {
    return null;
  }
}

function withoutIndexSuffix(pathValue: string): string | null {
  const next = pathValue.replace(/\/index(?:\.html?)?$/i, "") || "/";
  return next === pathValue ? null : next;
}

export function mirrorPathCandidates(pathValue: string): string[] {
  const candidates = new Set<string>();
  const queue: string[] = [normalizeMirrorPath(pathValue)];

  while (queue.length > 0) {
    const current = normalizeMirrorPath(queue.shift()!);
    if (candidates.has(current)) {
      continue;
    }

    candidates.add(current);

    const decoded = decodePath(current);
    if (decoded) {
      queue.push(decoded);
    }

    const encoded = encodePath(current);
    if (encoded) {
      queue.push(encoded);
    }

    const withoutIndex = withoutIndexSuffix(current);
    if (withoutIndex) {
      queue.push(withoutIndex);
    }

    if (current !== "/" && !/\/index(?:\.html?)?$/i.test(current) && !/\.[a-z0-9]+$/i.test(current)) {
      queue.push(`${current}/index`);
      queue.push(`${current}/index.html`);
    }
  }

  return [...candidates];
}

export function scopePathFor(entryUrl: string): string {
  const url = normalizeUserUrl(entryUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 0) {
    return "/";
  }

  const scopeMarkers = new Set(["api", "docs", "documentation", "guide", "guides", "learn", "reference"]);
  const markerIndex = parts.findIndex((part) => scopeMarkers.has(part.toLowerCase()));
  if (markerIndex >= 0) {
    return `/${parts.slice(0, markerIndex + 1).join("/")}`;
  }

  return `/${parts[0]}`;
}

export function mirrorHref(siteSlug: string, lang: string, urlValue: string, hash = ""): string {
  const path = mirrorPathFor(urlValue);
  return `/sites/${encodeURIComponent(siteSlug)}/${encodeURIComponent(lang)}${path}${hash}`;
}

export function isMirrorablePage(urlValue: string, rootUrl: string, scopePath = "/"): boolean {
  let url: URL;
  let root: URL;
  try {
    url = normalizeUserUrl(urlValue);
    root = normalizeUserUrl(rootUrl);
  } catch {
    return false;
  }

  if (url.hostname !== root.hostname) {
    return false;
  }

  const normalizedScope = scopePath.endsWith("/") && scopePath !== "/" ? scopePath.slice(0, -1) : scopePath;
  if (normalizedScope !== "/" && url.pathname !== normalizedScope && !url.pathname.startsWith(`${normalizedScope}/`)) {
    return false;
  }

  const lowerPath = url.pathname.toLowerCase();
  const extension = lowerPath.match(/\.[a-z0-9]+$/)?.[0];
  return !extension || !HTML_EXTENSIONS_TO_SKIP.has(extension);
}

export function canonicalPageUrl(urlValue: string): string {
  const url = normalizeUserUrl(urlValue);
  url.hash = "";
  return url.toString();
}

export function siteSlugFor(entryUrl: string): string {
  const url = normalizeUserUrl(entryUrl);
  const host = url.hostname.replace(/^www\./, "");
  const pathHint = url.pathname
    .split("/")
    .filter(Boolean)
    .slice(0, 2)
    .join("-");
  const base = `${host}${pathHint ? `-${pathHint}` : ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = sha256(url.toString()).slice(0, 8);
  return `${base || "site"}-${suffix}`;
}
