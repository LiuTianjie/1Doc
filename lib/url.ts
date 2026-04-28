const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => Number(part));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

function isBlockedIpv4(value: string): boolean {
  const octets = parseIpv4(value);
  if (!octets) {
    return false;
  }

  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isBlockedIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

export function isBlockedNetworkHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return BLOCKED_HOSTNAMES.has(normalized) || isBlockedIpv4(normalized) || isBlockedIpv6(normalized);
}

export function assertPublicUrl(url: URL): void {
  if (isBlockedNetworkHost(url.hostname)) {
    throw new Error("Private, local, and metadata URLs are not supported.");
  }
}

export function normalizeUserUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  const url = new URL(trimmed);

  if (!HTTP_PROTOCOLS.has(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  assertPublicUrl(url);
  url.hash = "";
  return url;
}

export function proxiedUrl(targetUrl: string, lang: string, path = "/view"): string {
  const params = new URLSearchParams({ url: targetUrl, lang });
  return `${path}?${params.toString()}`;
}

export function absoluteUrl(value: string, baseUrl: string): string {
  return new URL(value, baseUrl).toString();
}

export function isSameSite(target: URL, base: URL): boolean {
  return target.hostname === base.hostname;
}
