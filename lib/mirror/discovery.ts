import * as parse5 from "parse5";
import { fetchPage, hasBrowserRenderer, type FetchMode } from "../fetch-page";
import { absoluteUrl } from "../url";
import { canonicalPageUrl, isMirrorablePage } from "./url";
import type { DiscoverySource } from "./types";

const USER_AGENT =
  "1Doc/0.1 (+https://example.com; public documentation mirror generator)";

export type DiscoveredPage = {
  url: string;
  source: DiscoverySource;
};

function discoveryConcurrency(): number {
  const configured = Number(process.env.MIRROR_DISCOVERY_CONCURRENCY || 8);
  if (!Number.isFinite(configured)) {
    return 8;
  }

  return Math.max(1, Math.min(16, Math.floor(configured)));
}

function scopedUrl(rawUrl: string, rootUrl: string, scopePath: string): string | null {
  try {
    const canonical = canonicalPageUrl(rawUrl);
    return isMirrorablePage(canonical, rootUrl, scopePath) ? canonical : null;
  } catch {
    return null;
  }
}

function uniqueLimit(values: string[], limit: number): string[] {
  return [...new Set(values)].slice(0, limit);
}

function uniqueDiscoveredLimit(values: DiscoveredPage[], limit: number): DiscoveredPage[] {
  const byUrl = new Map<string, DiscoveredPage>();
  for (const value of values) {
    if (!byUrl.has(value.url)) {
      byUrl.set(value.url, value);
    }
    if (byUrl.size >= limit) {
      break;
    }
  }

  return [...byUrl.values()];
}

function renderedDiscoveryLimit(limit: number): number {
  const configured = Number(process.env.MIRROR_RENDERED_DISCOVERY_LIMIT || 50);
  if (!Number.isFinite(configured)) {
    return Math.min(limit, 50);
  }

  return Math.max(0, Math.min(limit, Math.floor(configured)));
}

function expandedDiscoveryLimit(limit: number): number {
  const configured = Number(process.env.MIRROR_EXPANDED_DISCOVERY_LIMIT || 20);
  if (!Number.isFinite(configured)) {
    return Math.min(limit, 20);
  }

  return Math.max(0, Math.min(limit, Math.floor(configured)));
}

function sitemapCandidates(entryUrl: string): string[] {
  const entry = new URL(entryUrl);
  const candidates = new Set<string>();
  candidates.add(`${entry.origin}/sitemap.xml`);
  candidates.add(`${entry.origin}/sitemap_index.xml`);
  candidates.add(`${entry.origin}/sitemap-index.xml`);
  candidates.add(`${entry.origin}/sitemap-pages.xml`);
  candidates.add(`${entry.origin}/docs/sitemap.xml`);

  const parts = entry.pathname.split("/").filter(Boolean);
  for (let index = parts.length; index > 0; index -= 1) {
    const prefix = `${entry.origin}/${parts.slice(0, index).join("/")}`;
    candidates.add(`${prefix}/sitemap.xml`);
    candidates.add(`${prefix}/sitemap_index.xml`);
    candidates.add(`${prefix}/sitemap-pages.xml`);
  }

  return [...candidates];
}

function extractSitemapLocs(xml: string): string[] {
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) =>
    match[1].replace(/&amp;/g, "&").trim()
  );
  return locs.filter(Boolean);
}

function extractRobotsSitemaps(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^sitemap:\s*(.+)$/i)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/xml,text/xml,text/plain,*/*",
        "user-agent": USER_AGENT
      },
      signal: controller.signal,
      cache: "no-store"
    });
    if (!response.ok) {
      return null;
    }
    return response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverFromSitemaps(
  entryUrl: string,
  rootUrl: string,
  scopePath: string,
  limit: number
): Promise<DiscoveredPage[]> {
  const entry = new URL(entryUrl);
  const robotsText = await fetchText(`${entry.origin}/robots.txt`);
  const queue = uniqueLimit(
    [...(robotsText ? extractRobotsSitemaps(robotsText) : []), ...sitemapCandidates(entryUrl)],
    75
  );
  const seenSitemaps = new Set<string>();
  const pages: DiscoveredPage[] = [];

  while (queue.length > 0 && pages.length < limit && seenSitemaps.size < 75) {
    const sitemapUrl = queue.shift()!;
    if (seenSitemaps.has(sitemapUrl)) {
      continue;
    }
    seenSitemaps.add(sitemapUrl);

    const xml = await fetchText(sitemapUrl);
    if (!xml) {
      continue;
    }

    for (const loc of extractSitemapLocs(xml)) {
      let locUrl: URL;
      try {
        locUrl = new URL(loc, sitemapUrl);
      } catch {
        continue;
      }

      if (/\.xml(\?.*)?$/i.test(locUrl.pathname)) {
        const nested = locUrl.toString();
        if (!seenSitemaps.has(nested)) {
          queue.push(nested);
        }
        continue;
      }

      const pageUrl = scopedUrl(locUrl.toString(), rootUrl, scopePath);
      if (pageUrl) {
        pages.push({ url: pageUrl, source: "sitemap" });
      }
      if (pages.length >= limit) {
        break;
      }
    }
  }

  return uniqueDiscoveredLimit(pages, limit);
}

function getAttrs(node: any): Array<{ name: string; value: string }> {
  return Array.isArray(node.attrs) ? node.attrs : [];
}

function getAttr(node: any, name: string): string | null {
  return getAttrs(node).find((attr) => attr.name.toLowerCase() === name)?.value ?? null;
}

function walk(node: any, visit: (node: any) => void): void {
  visit(node);
  if (!Array.isArray(node.childNodes)) {
    return;
  }

  for (const child of node.childNodes) {
    walk(child, visit);
  }
}

export function extractLinks(html: string, baseUrl: string, rootUrl: string, scopePath = "/"): string[] {
  const document = parse5.parse(html);
  const links: string[] = [];

  walk(document, (node) => {
    const tagName = node.tagName;
    if (!tagName) {
      return;
    }

    let href: string | null = null;
    if (tagName === "a" || tagName === "area") {
      href = getAttr(node, "href");
    } else if (tagName === "link") {
      const rel = getAttr(node, "rel")?.toLowerCase() ?? "";
      if (/\b(canonical|alternate|next|prev)\b/.test(rel)) {
        href = getAttr(node, "href");
      }
    }

    if (!href || href.startsWith("#") || /^(mailto|tel|javascript|data|blob):/i.test(href)) {
      return;
    }

    try {
      const resolved = absoluteUrl(href, baseUrl);
      const canonical = scopedUrl(resolved, rootUrl, scopePath);
      if (canonical) {
        links.push(canonical);
      }
    } catch {
      // Ignore malformed links.
    }
  });

  return [...new Set(links)];
}

async function discoverFromCrawl(
  entryUrl: string,
  rootUrl: string,
  scopePath: string,
  limit: number,
  seeds: DiscoveredPage[],
  fetchMode: FetchMode,
  linkSource: DiscoverySource,
  fetchLimit = limit
): Promise<DiscoveredPage[]> {
  const queue = uniqueDiscoveredLimit([{ url: entryUrl, source: "manual" }, ...seeds], Math.max(limit, seeds.length + 1));
  const seen = new Set<string>();
  const queued = new Set(queue.map((page) => page.url));
  const pages = new Map<string, DiscoveredPage>();
  const concurrency = discoveryConcurrency();
  let fetchCount = 0;

  async function worker(): Promise<void> {
    while (pages.size < limit && fetchCount < fetchLimit) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      if (seen.has(next.url)) {
        continue;
      }
      seen.add(next.url);

      const canonical = scopedUrl(next.url, rootUrl, scopePath);
      if (!canonical) {
        continue;
      }
      if (!pages.has(canonical)) {
        pages.set(canonical, { url: canonical, source: next.source });
      }
      fetchCount += 1;

      try {
        const fetched = await fetchPage(canonical, { mode: fetchMode });
        for (const link of extractLinks(fetched.html, fetched.finalUrl, rootUrl, scopePath)) {
          if (!seen.has(link) && !queued.has(link) && queued.size < limit * 3) {
            queued.add(link);
            queue.push({ url: link, source: linkSource });
          }
        }
      } catch {
        // Discovery should be best-effort; page fetch failures are handled during generation.
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return uniqueDiscoveredLimit([...pages.values()], limit);
}

export async function discoverSitePages(
  entryUrl: string,
  rootUrl: string,
  scopePath: string,
  limit: number
): Promise<DiscoveredPage[]> {
  const sitemapPages = await discoverFromSitemaps(entryUrl, rootUrl, scopePath, limit);
  const staticPages = await discoverFromCrawl(
    entryUrl,
    rootUrl,
    scopePath,
    limit,
    sitemapPages.slice(0, 25),
    "static",
    "static_dom"
  );
  const discovered = uniqueDiscoveredLimit([{ url: canonicalPageUrl(entryUrl), source: "manual" }, ...sitemapPages, ...staticPages], limit);

  if (!hasBrowserRenderer() || discovered.length >= limit) {
    return discovered;
  }

  const renderedPages = await discoverFromCrawl(
    entryUrl,
    rootUrl,
    scopePath,
    limit,
    discovered.slice(0, renderedDiscoveryLimit(limit)),
    "rendered",
    "rendered_dom",
    renderedDiscoveryLimit(limit)
  );
  const withRendered = uniqueDiscoveredLimit([...discovered, ...renderedPages], limit);

  if (withRendered.length >= limit || expandedDiscoveryLimit(limit) === 0) {
    return withRendered;
  }

  const interactionPages = await discoverFromCrawl(
    entryUrl,
    rootUrl,
    scopePath,
    limit,
    withRendered.slice(0, expandedDiscoveryLimit(limit)),
    "rendered_with_expansion",
    "interaction",
    expandedDiscoveryLimit(limit)
  );

  return uniqueDiscoveredLimit([...withRendered, ...interactionPages], limit);
}
