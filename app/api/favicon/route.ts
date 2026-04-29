import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { assertPublicUrl, isBlockedNetworkHost, normalizeUserUrl } from "@/lib/url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USER_AGENT = "1Doc/0.1 (+https://example.com; favicon proxy)";
const MAX_ICON_BYTES = 512 * 1024;

async function assertPublicFetchUrl(url: URL): Promise<void> {
  assertPublicUrl(url);
  if (isIP(url.hostname)) {
    return;
  }

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.some((address) => isBlockedNetworkHost(address.address))) {
    throw new Error("Target hostname resolves to a private or local address.");
  }
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function iconHrefFromHtml(html: string, baseUrl: string): string | null {
  const matches = html.matchAll(/<link\b[^>]*>/gi);
  const candidates: Array<{ href: string; score: number }> = [];

  for (const match of matches) {
    const tag = match[0];
    const rel = tag.match(/\brel\s*=\s*["']?([^"'>\s]+)/i)?.[1]?.toLowerCase() ?? "";
    if (!rel.split(/\s+/).some((part) => part === "icon" || part === "shortcut" || part === "apple-touch-icon")) {
      continue;
    }

    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] ?? tag.match(/\bhref\s*=\s*([^\s>]+)/i)?.[1];
    if (!href || /^(data|javascript|blob):/i.test(href)) {
      continue;
    }

    const type = tag.match(/\btype\s*=\s*["']?([^"'>\s]+)/i)?.[1]?.toLowerCase() ?? "";
    const sizes = tag.match(/\bsizes\s*=\s*["']?([^"'>\s]+)/i)?.[1]?.toLowerCase() ?? "";
    const score =
      (type.includes("svg") ? 40 : 0) +
      (sizes.includes("64") || sizes.includes("32") ? 20 : 0) +
      (rel.includes("apple") ? 5 : 0);
    candidates.push({ href: new URL(href, baseUrl).toString(), score });
  }

  return candidates.sort((a, b) => b.score - a.score)[0]?.href ?? null;
}

async function discoverIconUrl(entryUrl: URL, signal: AbortSignal): Promise<URL> {
  await assertPublicFetchUrl(entryUrl);
  const response = await fetch(entryUrl, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": USER_AGENT
    },
    signal,
    cache: "no-store"
  });

  if (response.ok && (response.headers.get("content-type") || "").includes("html")) {
    const html = await response.text();
    const href = iconHrefFromHtml(html.slice(0, 200_000), response.url || entryUrl.toString());
    if (href) {
      return normalizeUserUrl(href);
    }
  }

  return new URL("/favicon.ico", entryUrl.origin);
}

async function fetchIcon(iconUrl: URL, signal: AbortSignal): Promise<Response> {
  await assertPublicFetchUrl(iconUrl);
  const response = await fetch(iconUrl, {
    headers: {
      accept: "image/avif,image/webp,image/svg+xml,image/png,image/x-icon,image/*,*/*;q=0.8",
      "user-agent": USER_AGENT
    },
    signal,
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Icon returned ${response.status}.`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_ICON_BYTES) {
    throw new Error("Icon is too large.");
  }

  const contentType = response.headers.get("content-type") || "image/x-icon";
  if (!contentType.startsWith("image/") && !contentType.includes("octet-stream")) {
    throw new Error("Icon response was not an image.");
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_ICON_BYTES) {
    throw new Error("Icon is too large.");
  }

  return new Response(bytes, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=86400, stale-while-revalidate=604800"
    }
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawUrl = searchParams.get("url");
  if (!rawUrl) {
    return new Response("Missing url.", { status: 400 });
  }

  try {
    return await withTimeout(async (signal) => {
      const entryUrl = normalizeUserUrl(rawUrl);
      const iconUrl = await discoverIconUrl(entryUrl, signal);
      return fetchIcon(iconUrl, signal);
    }, 8000);
  } catch {
    return new Response(null, {
      status: 204,
      headers: {
        "cache-control": "public, max-age=3600"
      }
    });
  }
}
