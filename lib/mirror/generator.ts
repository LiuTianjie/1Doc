import { fetchErrorCode, fetchPage, type FetchMode, type FetchPageResult } from "../fetch-page";
import { sha256 } from "../hash";
import { translateMirrorHtmlWithStats } from "../html";
import { discoverSitePages, type DiscoveredPage } from "./discovery";
import { generateSiteLlmTexts } from "./llm-text";
import {
  addJobEvent,
  bulkUpsertSourcePages,
  getDocSiteById,
  getMirroredPage,
  getSourcePageById,
  listSourcePages,
  recomputeSiteCounters,
  releaseGenerationJob,
  updateDocSite,
  updateGenerationJob,
  upsertMirroredPage,
  upsertSourcePage
} from "./store";
import { mirrorPathFor, scopePathFor } from "./url";
import type { DiscoverySource, DocSite, GenerationMode, PageFetchErrorCode, PageFetchMode, SourcePage } from "./types";

function titleFromHtml(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return null;
  }

  return match[1].replace(/\s+/g, " ").trim() || null;
}

type FetchAttemptResult = FetchPageResult & {
  attemptCount: number;
  lastAttemptedMode: PageFetchMode;
};

class FetchAttemptError extends Error {
  constructor(
    readonly originalError: unknown,
    readonly attemptCount: number,
    readonly lastAttemptedMode: PageFetchMode
  ) {
    super(originalError instanceof Error ? originalError.message : "fetch failed", {
      cause: originalError
    });
  }
}

const FETCH_LADDER: FetchMode[] = ["static", "rendered", "rendered_with_expansion"];

function fetchModeLadder(preferredMode: PageFetchMode | null): FetchMode[] {
  if (!preferredMode) {
    return FETCH_LADDER;
  }

  return [preferredMode, ...FETCH_LADDER.filter((mode) => mode !== preferredMode)];
}

async function fetchPageWithRetry(url: string, preferredMode: PageFetchMode | null): Promise<FetchAttemptResult> {
  let lastError: unknown;
  let attemptCount = 0;
  let lastAttemptedMode: PageFetchMode = preferredMode ?? "static";

  for (const mode of fetchModeLadder(preferredMode)) {
    const attemptsForMode = mode === "static" ? 2 : 1;
    for (let attempt = 1; attempt <= attemptsForMode; attempt += 1) {
      attemptCount += 1;
      lastAttemptedMode = mode;
      try {
        const fetched = await fetchPage(url, { mode });
        return {
          ...fetched,
          attemptCount,
          lastAttemptedMode: fetched.fetchMode
        };
      } catch (error) {
        lastError = error;
        if (attempt < attemptsForMode) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 750));
        }
      }
    }
  }

  throw new FetchAttemptError(lastError, attemptCount, lastAttemptedMode);
}

function generationFetchErrorCode(error: unknown): PageFetchErrorCode {
  return fetchErrorCode(error instanceof FetchAttemptError ? error.originalError : error) as PageFetchErrorCode;
}

function sourceCounts(pages: DiscoveredPage[]): Record<DiscoverySource, number> {
  return pages.reduce(
    (counts, page) => {
      counts[page.source] += 1;
      return counts;
    },
    { sitemap: 0, static_dom: 0, rendered_dom: 0, interaction: 0, manual: 0 } satisfies Record<DiscoverySource, number>
  );
}

function fetchModeCounts(pages: SourcePage[]): Record<PageFetchMode, number> {
  return pages.reduce(
    (counts, page) => {
      if (page.last_fetch_mode) {
        counts[page.last_fetch_mode] += 1;
      }
      return counts;
    },
    { static: 0, rendered: 0, rendered_with_expansion: 0 } satisfies Record<PageFetchMode, number>
  );
}

function pageConcurrency(): number {
  const configured = Number(process.env.MIRROR_PAGE_CONCURRENCY || 8);
  if (!Number.isFinite(configured)) {
    return 8;
  }
  return Math.max(1, Math.min(16, Math.floor(configured)));
}

function languageConcurrency(): number {
  const configured = Number(process.env.MIRROR_LANG_CONCURRENCY || 2);
  if (!Number.isFinite(configured)) {
    return 2;
  }
  return Math.max(1, Math.min(4, Math.floor(configured)));
}

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  handler: (item: T, index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await handler(items[index], index);
      }
    })
  );
}

async function updateJobProgress(siteId: string, jobId: string | undefined, status?: "running" | "succeeded" | "failed"): Promise<void> {
  if (!jobId) {
    return;
  }

  const pages = await listSourcePages(siteId);
  await updateGenerationJob(jobId, {
    ...(status ? { status } : {}),
    pages_total: pages.length,
    pages_done: pages.filter((page) => page.status === "ready" || page.status === "skipped").length,
    pages_failed: pages.filter((page) => page.status === "failed").length,
    ...(status === "succeeded" || status === "failed" ? { finished_at: new Date().toISOString() } : {})
  });
}

async function generateSourcePage(
  site: DocSite,
  page: SourcePage,
  scopePath: string,
  jobId?: string,
  options: { syncProgress?: boolean } = {}
): Promise<void> {
  let attemptCount = page.attempt_count ?? 0;
  let lastFetchMode = page.last_fetch_mode;
  let typedError: PageFetchErrorCode | null = null;
  try {
    await upsertSourcePage({ ...page, status: "fetching", last_error: null, typed_error: null });
    await addJobEvent(site.id, "info", "Fetching page", { url: page.url, preferredFetchMode: page.last_fetch_mode });

    const fetched = await fetchPageWithRetry(page.url, page.typed_error ? null : page.last_fetch_mode);
    attemptCount += fetched.attemptCount;
    lastFetchMode = fetched.fetchMode;
    const htmlHash = sha256(fetched.html);
    const pageTitle = titleFromHtml(fetched.html);
    const sourcePage = await upsertSourcePage({
      ...page,
      title: pageTitle,
      html_hash: htmlHash,
      status: "translating",
      last_error: null,
      last_fetch_mode: fetched.fetchMode,
      attempt_count: attemptCount,
      typed_error: null
    });
    await addJobEvent(site.id, "info", "Page fetched", {
      url: page.url,
      fetchMode: fetched.fetchMode,
      rendered: fetched.rendered,
      attempts: fetched.attemptCount
    });

    const langResults = new Map<string, "generated" | "reused">();
    await runConcurrent(site.target_langs, languageConcurrency(), async (lang) => {
      const existing = await getMirroredPage(site.id, lang, sourcePage.path);
      if (existing?.source_html_hash === htmlHash) {
        langResults.set(lang, "reused");
        await addJobEvent(site.id, "info", "Page unchanged, reused mirror", {
          url: page.url,
          lang
        });
        return;
      }

      await addJobEvent(site.id, "info", "Translating page", { url: page.url, lang });
      const mirror = await translateMirrorHtmlWithStats(
        fetched.html,
        fetched.finalUrl,
        lang,
        site.slug,
        site.root_url,
        scopePath
      );
      await upsertSourcePage({ ...sourcePage, status: "publishing", last_error: null });
      await upsertMirroredPage({
        site_id: site.id,
        source_page_id: sourcePage.id,
        lang,
        path: sourcePage.path,
        html: mirror.html,
        source_html_hash: htmlHash
      });
      await addJobEvent(site.id, "info", "DocIR page translated", {
        url: page.url,
        lang,
        blocks: mirror.stats.blockCount,
        textSegments: mirror.stats.textSegmentCount,
        translatedSegments: mirror.stats.translatedSegmentCount,
        untranslatedSegments: mirror.stats.untranslatedSegmentCount,
        rootFound: mirror.stats.rootFound
      });
      langResults.set(lang, "generated");
    });

    await upsertSourcePage({
      ...sourcePage,
      status: [...langResults.values()].every((status) => status === "reused") ? "skipped" : "ready",
      last_error: null,
      last_fetch_mode: fetched.fetchMode,
      attempt_count: attemptCount,
      typed_error: null
    });
    if (options.syncProgress) {
      await recomputeSiteCounters(site.id);
      await updateJobProgress(site.id, jobId);
    }
  } catch (error) {
    if (error instanceof FetchAttemptError) {
      attemptCount += error.attemptCount;
      lastFetchMode = error.lastAttemptedMode;
    }
    typedError = generationFetchErrorCode(error);
    await upsertSourcePage({
      ...page,
      status: "failed",
      last_error: error instanceof Error ? error.message : "Unknown page generation error.",
      last_fetch_mode: lastFetchMode,
      attempt_count: attemptCount,
      typed_error: typedError
    });
    await addJobEvent(site.id, "error", "Page generation failed", {
      url: page.url,
      error: error instanceof Error ? error.message : "Unknown error",
      typedError,
      fetchMode: lastFetchMode,
      attempts: attemptCount
    });
    if (options.syncProgress) {
      await recomputeSiteCounters(site.id);
      await updateJobProgress(site.id, jobId);
    }
  }
}

export async function retryMirrorPage(siteId: string, pageId: string): Promise<void> {
  const site = await getDocSiteById(siteId);
  if (!site) {
    throw new Error(`Site ${siteId} was not found.`);
  }

  const page = await getSourcePageById(siteId, pageId);
  if (!page) {
    throw new Error(`Page ${pageId} was not found.`);
  }

  await updateDocSite(site.id, { status: "generating", last_error: null });
  await addJobEvent(site.id, "info", "Retrying single page", { url: page.url, path: page.path });
  await generateSourcePage(site, page, site.scope_path || scopePathFor(site.entry_url), undefined, { syncProgress: true });
  await recomputeSiteCounters(site.id);

  const pages = await listSourcePages(site.id);
  const hasReady = pages.some((candidate) => candidate.status === "ready" || candidate.status === "skipped");
  await recomputeSiteCounters(site.id, hasReady ? "ready" : "failed");
}

export async function generateMirrorSite(
  siteId: string,
  jobId?: string,
  options: { mode?: GenerationMode } = {}
): Promise<void> {
  const site = await getDocSiteById(siteId);
  if (!site) {
    throw new Error(`Site ${siteId} was not found.`);
  }

  try {
    if (jobId) {
      await updateGenerationJob(jobId, {
        status: "running",
        started_at: new Date().toISOString(),
        last_error: null
      });
    }
    const scopePath = site.scope_path || scopePathFor(site.entry_url);
    const mode = options.mode ?? "incremental";

    if (mode === "incremental") {
      await updateDocSite(site.id, { status: "discovering", last_error: null });
      await addJobEvent(site.id, "info", "Discovering pages", { entryUrl: site.entry_url });

      const discoveredPages = await discoverSitePages(site.entry_url, site.root_url, scopePath, site.page_limit);
      await addJobEvent(site.id, "info", "Pages discovered", {
        count: discoveredPages.length,
        limit: site.page_limit,
        limitReached: discoveredPages.length >= site.page_limit,
        sources: sourceCounts(discoveredPages)
      });
      const existingPages = await listSourcePages(site.id);
      const existingByPath = new Map(existingPages.map((page) => [page.path, page]));
      await bulkUpsertSourcePages(discoveredPages.map((discovered) => {
        const path = mirrorPathFor(discovered.url);
        const existing = existingByPath.get(path);
        return {
          site_id: site.id,
          url: discovered.url,
          path,
          title: existing?.title ?? null,
          html_hash: existing?.html_hash ?? null,
          status: "queued",
          last_error: null,
          discovery_source: existing?.discovery_source ?? discovered.source,
          last_fetch_mode: existing?.last_fetch_mode ?? null,
          attempt_count: existing?.attempt_count ?? 0,
          typed_error: null
        };
      }), existingPages);
    } else if (mode === "refresh_existing") {
      await updateDocSite(site.id, { status: "generating", last_error: null });
      await addJobEvent(site.id, "info", "Refreshing existing pages", { entryUrl: site.entry_url });
    } else {
      await updateDocSite(site.id, { status: "generating", last_error: null });
      await addJobEvent(site.id, "info", "Retrying failed pages", { entryUrl: site.entry_url });
    }

    await recomputeSiteCounters(site.id, "generating");
    await updateJobProgress(site.id, jobId, "running");
    const concurrency = pageConcurrency();
    const allPages = await listSourcePages(site.id);
    await addJobEvent(site.id, "info", "Generating mirrored pages", {
      pages: allPages.length,
      concurrency,
      fetchModes: fetchModeCounts(allPages)
    });

    const pages = mode === "retry_failed" ? allPages.filter((page) => page.status === "failed") : allPages;
    await runConcurrent(pages, concurrency, (page) => generateSourcePage(site, page, scopePath, jobId));
    await recomputeSiteCounters(site.id, "generating");
    await updateJobProgress(site.id, jobId, "running");

    const latestSite = (await getDocSiteById(site.id)) ?? site;
    if (latestSite.target_langs.some((lang) => !site.target_langs.includes(lang))) {
      const latestPages = await listSourcePages(site.id);
      await addJobEvent(site.id, "info", "Generating newly requested languages", {
        targetLangs: latestSite.target_langs
      });
      await runConcurrent(latestPages, concurrency, (page) => generateSourcePage(latestSite, page, scopePath, jobId));
      await recomputeSiteCounters(site.id, "generating");
      await updateJobProgress(site.id, jobId, "running");
    }

    const finalPages = await listSourcePages(site.id);
    await addJobEvent(site.id, "info", "Fetch mode summary", {
      fetchModes: fetchModeCounts(finalPages),
      failedTypedErrors: finalPages.reduce<Record<string, number>>((counts, page) => {
        if (page.typed_error) {
          counts[page.typed_error] = (counts[page.typed_error] ?? 0) + 1;
        }
        return counts;
      }, {})
    });
    const hasReady = finalPages.some((page) => page.status === "ready" || page.status === "skipped");
    await recomputeSiteCounters(site.id, hasReady ? "ready" : "failed");
    if (hasReady) {
      try {
        const latestSite = (await getDocSiteById(site.id)) ?? site;
        const llmTexts = await generateSiteLlmTexts(site.id, latestSite.target_langs);
        await addJobEvent(site.id, "info", "LLM.txt generated", {
          langs: llmTexts.map((item) => item.lang),
          pages: llmTexts.reduce((total, item) => total + item.page_count, 0)
        });
      } catch (llmError) {
        await addJobEvent(site.id, "error", "LLM.txt generation failed", {
          error: llmError instanceof Error ? llmError.message : "Unknown error"
        });
      }
    }
    await updateJobProgress(site.id, jobId, hasReady ? "succeeded" : "failed");
    if (jobId) {
      await releaseGenerationJob(site.id, jobId);
    }
    await addJobEvent(site.id, hasReady ? "info" : "error", hasReady ? "Mirror generation complete" : "No pages generated");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown site generation error.";
    let hasGeneratedPages = false;
    try {
      const sourcePages = await listSourcePages(site.id);
      hasGeneratedPages = sourcePages.some((page) => page.status === "ready" || page.status === "skipped");
      await recomputeSiteCounters(site.id, hasGeneratedPages ? "ready" : "failed");
      if (!hasGeneratedPages) {
        await updateDocSite(site.id, { last_error: errorMessage });
      }
    } catch {
      await updateDocSite(site.id, {
        status: "failed",
        last_error: errorMessage
      });
    }
    await addJobEvent(site.id, "error", "Site generation failed", {
      error: errorMessage
    });
    if (jobId) {
      await updateGenerationJob(jobId, {
        status: "failed",
        last_error: errorMessage,
        finished_at: new Date().toISOString()
      });
      await releaseGenerationJob(site.id, jobId);
    }
    throw error;
  }
}
