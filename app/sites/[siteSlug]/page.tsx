"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { GitHubLink } from "../../components/GitHubLink";
import { MirrorSearch } from "../../components/MirrorSearch";
import { SiteFooter } from "../../components/SiteFooter";
import { LocaleSwitcher, useI18n } from "../../i18n";

type SiteStatus = "queued" | "discovering" | "generating" | "ready" | "failed";
type PageStatus = "queued" | "fetching" | "translating" | "publishing" | "ready" | "skipped" | "failed";
type PageFilter = "all" | "active" | "failed" | "ready";

type SourcePageDetail = {
  id: string;
  url: string;
  path: string;
  title: string | null;
  html_hash: string | null;
  status: PageStatus;
  last_error: string | null;
  discovered_at: string;
  updated_at: string;
};

type MirroredPageDetail = {
  lang: string;
  path: string;
  source_html_hash: string;
  generated_at: string;
};

type JobEventDetail = {
  id: string;
  site_id: string;
  level: "info" | "error";
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

type SiteProgress = {
  site: {
    id: string;
    slug: string;
    entry_url: string;
    entry_path: string;
    target_langs: string[];
    status: SiteStatus;
    page_limit: number;
    discovered_count: number;
    generated_count: number;
    failed_count: number;
    last_error: string | null;
    updated_at: string;
    faviconUrl: string | null;
  };
  llmTexts: Array<{ lang: string; page_count: number; generated_at: string; updated_at: string }>;
  events: JobEventDetail[];
  mirrorUrls: Array<{ lang: string; url: string }>;
};

type SourcePageListItem = SourcePageDetail & {
  generatedCount: number;
  generatedLangs: string[];
  mirrorUrlsByLang: Record<string, string>;
  mirroredPages: MirroredPageDetail[];
};

type PageCounts = Record<PageFilter, number>;

function formatTime(value: string, locale: string): string {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function progressFor(progress: SiteProgress | null): number {
  if (!progress) {
    return 0;
  }
  if (progress.site.status === "ready") {
    return 100;
  }

  const expected = Math.max(progress.site.discovered_count * progress.site.target_langs.length, 1);
  return Math.min(100, Math.round((progress.site.generated_count / expected) * 100));
}

function liveCounts(progress: SiteProgress) {
  return {
    discovered: progress.site.discovered_count,
    generated: progress.site.generated_count,
    failed: progress.site.failed_count
  };
}

function pathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function compactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}

function eventText(event: JobEventDetail): string {
  const error = typeof event.metadata.error === "string" ? event.metadata.error : "";
  const url = typeof event.metadata.url === "string" ? event.metadata.url : "";
  const blocks = typeof event.metadata.blocks === "number" ? ` · ${event.metadata.blocks} blocks` : "";
  const untranslated =
    typeof event.metadata.untranslatedSegments === "number"
      ? ` · ${event.metadata.untranslatedSegments} untranslated`
      : "";
  const pageHint = url ? ` · ${pathFromUrl(url)}` : "";
  return `${event.message}${error ? `: ${error}` : ""}${blocks}${untranslated}${pageHint}`;
}

export default function SiteDetailPage() {
  const { locale, t } = useI18n();
  const params = useParams<{ siteSlug: string }>();
  const siteSlug = params.siteSlug;
  const [progress, setProgress] = useState<SiteProgress | null>(null);
  const [pages, setPages] = useState<SourcePageListItem[]>([]);
  const [pageCounts, setPageCounts] = useState<PageCounts>({ all: 0, active: 0, failed: 0, ready: 0 });
  const [nextPageCursor, setNextPageCursor] = useState<string | null>(null);
  const [pageFilter, setPageFilter] = useState<PageFilter>("all");
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingPages, setIsLoadingPages] = useState(true);
  const [isLoadingMorePages, setIsLoadingMorePages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [retryingPageId, setRetryingPageId] = useState<string | null>(null);
  const [llmTextState, setLlmTextState] = useState<"idle" | "working" | "copied">("idle");
  const loadMorePagesRef = useRef<HTMLDivElement>(null);
  const nextPageCursorRef = useRef<string | null>(null);
  const loadingMorePagesRef = useRef(false);

  function updateNextPageCursor(value: string | null) {
    nextPageCursorRef.current = value;
    setNextPageCursor(value);
  }

  function appendPages(current: SourcePageListItem[], incoming: SourcePageListItem[]): SourcePageListItem[] {
    const existingIds = new Set(current.map((page) => page.id));
    return [...current, ...incoming.filter((page) => !existingIds.has(page.id))];
  }

  function mergeFirstPage(current: SourcePageListItem[], incoming: SourcePageListItem[]): SourcePageListItem[] {
    const incomingIds = new Set(incoming.map((page) => page.id));
    return [...incoming, ...current.filter((page) => !incomingIds.has(page.id))];
  }

  async function loadProgress() {
    try {
      const response = await fetch(`/api/sites/${siteSlug}`, { cache: "no-store" });
      const payload = (await response.json()) as SiteProgress | { error?: string };
      if (!response.ok) {
        throw new Error((payload as { error?: string }).error || t("detail.loadFailed"));
      }
      setProgress(payload as SiteProgress);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("detail.loadFailed"));
    } finally {
      setIsLoading(false);
    }
  }

  async function loadPages(
    filter = pageFilter,
    options: { append?: boolean; cursor?: string | null; silent?: boolean } = {}
  ) {
    if (options.append) {
      const cursor = options.cursor ?? nextPageCursorRef.current;
      if (!cursor || loadingMorePagesRef.current) {
        return;
      }
      loadingMorePagesRef.current = true;
      setIsLoadingMorePages(true);
    } else if (!options.silent) {
      setIsLoadingPages(true);
    }

    try {
      const params = new URLSearchParams({ filter });
      const cursor = options.append ? options.cursor ?? nextPageCursorRef.current : options.cursor;
      if (cursor) {
        params.set("cursor", cursor);
      }
      const response = await fetch(`/api/sites/${siteSlug}/pages?${params.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as {
        pages?: SourcePageListItem[];
        counts?: PageCounts;
        nextCursor?: string | null;
        error?: string;
      };
      if (!response.ok || !payload.pages || !payload.counts) {
        throw new Error(payload.error || t("detail.loadFailed"));
      }

      setPages((current) => {
        if (options.append) {
          return appendPages(current, payload.pages ?? []);
        }
        if (options.silent) {
          return mergeFirstPage(current, payload.pages ?? []);
        }
        return payload.pages ?? [];
      });
      setPageCounts(payload.counts);
      if (!options.silent || options.append) {
        updateNextPageCursor(payload.nextCursor ?? null);
      }
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("detail.loadFailed"));
    } finally {
      setIsLoadingPages(false);
      setIsLoadingMorePages(false);
      if (options.append) {
        loadingMorePagesRef.current = false;
      }
    }
  }

  useEffect(() => {
    setPages([]);
    updateNextPageCursor(null);
    setIsLoadingPages(true);
    loadProgress();
    loadPages(pageFilter);
    const timer = window.setInterval(() => {
      loadProgress();
      loadPages(pageFilter, { silent: true });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [siteSlug, pageFilter]);

  useEffect(() => {
    const node = loadMorePagesRef.current;
    if (!node || !nextPageCursor || isLoadingPages || isLoadingMorePages) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const cursor = nextPageCursorRef.current;
        if (entries.some((entry) => entry.isIntersecting) && cursor && !loadingMorePagesRef.current) {
          void loadPages(pageFilter, { append: true, cursor, silent: true });
        }
      },
      { rootMargin: "280px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [nextPageCursor, pageFilter, isLoadingPages, isLoadingMorePages]);

  async function refreshSite() {
    if (!progress) return;
    setRefreshing(true);
    setError(null);
    try {
      const response = await fetch(`/api/sites/${progress.site.slug}/refresh`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || t("detail.refreshFailed"));
      }
      await Promise.all([loadProgress(), loadPages(pageFilter)]);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : t("detail.refreshFailed"));
    } finally {
      setRefreshing(false);
    }
  }

  async function retryFailedPages() {
    if (!progress) return;
    setRetryingFailed(true);
    setError(null);
    try {
      const response = await fetch(`/api/sites/${progress.site.slug}/retry-failed`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || t("detail.retryFailedPagesFailed"));
      }
      await Promise.all([loadProgress(), loadPages(pageFilter)]);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : t("detail.retryFailedPagesFailed"));
    } finally {
      setRetryingFailed(false);
    }
  }

  async function retrySinglePage(pageId: string) {
    if (!progress) return;
    setRetryingPageId(pageId);
    setError(null);
    try {
      const response = await fetch(`/api/sites/${progress.site.slug}/pages/${pageId}/retry`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || t("detail.retryPageFailed"));
      }
      await Promise.all([loadProgress(), loadPages(pageFilter)]);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : t("detail.retryPageFailed"));
    } finally {
      setRetryingPageId(null);
    }
  }

  async function copyLlmText(lang: string) {
    if (!progress || llmTextState === "working") return;
    const hasLlmText = Boolean(progress.llmTexts.find((item) => item.lang === lang));
    setLlmTextState("working");
    setError(null);
    try {
      let response = hasLlmText
        ? await fetch(`/api/sites/${progress.site.slug}/llm-text?lang=${encodeURIComponent(lang)}`, { cache: "no-store" })
        : await fetch(`/api/sites/${progress.site.slug}/llm-text`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ lang })
          });
      let payload = (await response.json()) as {
        content?: string;
        llmText?: { content: string; lang: string; page_count: number; generated_at: string; updated_at: string };
        error?: string;
      };
      if (!response.ok && response.status === 404 && hasLlmText) {
        response = await fetch(`/api/sites/${progress.site.slug}/llm-text`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lang })
        });
        payload = (await response.json()) as typeof payload;
      }
      if (!response.ok) {
        throw new Error(payload.error || t("common.copyFailed"));
      }
      const content = payload.content ?? payload.llmText?.content;
      if (!content) {
        throw new Error(t("common.copyFailed"));
      }
      await navigator.clipboard.writeText(content);
      if (payload.llmText) {
        const generatedLlmText = payload.llmText;
        setProgress((current) =>
          current
            ? {
                ...current,
                llmTexts: [...current.llmTexts.filter((item) => item.lang !== generatedLlmText.lang), generatedLlmText]
              }
            : current
        );
      }
      setLlmTextState("copied");
      window.setTimeout(() => setLlmTextState("idle"), 1500);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : t("common.copyFailed"));
      setLlmTextState("idle");
    }
  }

  const recentEvents = (progress?.events ?? []).slice(-12).reverse();
  const counts = progress ? liveCounts(progress) : null;

  function statusLabel(status: SiteStatus): string {
    const labels: Record<SiteStatus, string> = {
      queued: t("status.queued"),
      discovering: t("status.discovering"),
      generating: t("status.generating"),
      ready: t("status.ready"),
      failed: t("status.failed")
    };
    return labels[status];
  }

  function pageStatusLabel(page: SourcePageDetail, generatedCount: number, targetLangCount: number): string {
    if (page.status === "failed") return t("status.failed");
    if (page.status === "fetching") return t("pageStatus.fetching");
    if (page.status === "queued") return t("pageStatus.queued");
    if (page.status === "translating") return t("pageStatus.translating");
    if (page.status === "publishing") return t("pageStatus.publishing");
    if (page.status === "skipped") return t("pageStatus.skipped");
    if (generatedCount >= targetLangCount) return t("pageStatus.ready");
    if (generatedCount > 0) return t("pageStatus.partial");
    return t("pageStatus.translating");
  }

  return (
    <main className="dashboard-shell">
      <section className="dashboard detail-page" aria-labelledby="detail-title">
        <nav className="topbar submit-topbar" aria-label="1Doc">
          <a className="brand-lockup" href="/">
            <img src="/1doc-icon.png" alt="" aria-hidden="true" />
            <strong>1Doc</strong>
          </a>
          <div className="topbar-actions">
            <MirrorSearch />
            <a className="nav-link" href="/">
              {t("nav.plaza")}
            </a>
            <a className="nav-link" href="/submit">
              {t("nav.submit")}
            </a>
            <LocaleSwitcher />
            <GitHubLink />
          </div>
        </nav>

        {isLoading || !progress ? (
          error ? <div className="empty-state">{error}</div> : <DetailPageSkeleton />
        ) : (
          <>
            <header className="dashboard-header detail-hero">
              <div>
                <div className="detail-title-row">
                  <SiteFavicon progress={progress} />
                  <p className="eyebrow">{t("detail.eyebrow")}</p>
                </div>
                <h1 id="detail-title" className="url-title">{progress.site.entry_url}</h1>
                <p className="summary">{compactUrl(progress.site.entry_url)}</p>
              </div>
              <div className="detail-hero-actions">
                <span className={`status-pill status-${progress.site.status}`}>{statusLabel(progress.site.status)}</span>
                <a className="ghost-button" href={progress.site.entry_url} target="_blank" rel="noreferrer">
                  {t("common.original")}
                </a>
              </div>
            </header>

            <section className="projects-panel detail-overview" aria-label={t("detail.overview")}>
              <div className="meter" aria-label={t("common.generationProgress", { progress: progressFor(progress) })}>
                <span style={{ width: `${progressFor(progress)}%` }} />
              </div>
              <div className="card-metrics">
                <div>
                  <strong>{counts?.discovered ?? 0}</strong>
                  <span>{t("detail.foundPages")}</span>
                </div>
                <div>
                  <strong>{counts?.generated ?? 0}</strong>
                  <span>{t("detail.snapshots")}</span>
                </div>
                <div>
                  <strong>{counts?.failed ?? 0}</strong>
                  <span>{t("detail.failedPages")}</span>
                </div>
                <div>
                  <strong>{progress.site.target_langs.join(", ")}</strong>
                  <span>{t("detail.targetLangs")}</span>
                </div>
              </div>
              <div className="project-actions">
                <DetailLanguageVisitPill progress={progress} />
                {progress.site.status === "ready" && progress.mirrorUrls[0] ? (
                  <div className="llm-copy-wrap">
                    <button
                      className="llm-copy-button"
                      type="button"
                      onClick={() => copyLlmText(progress.mirrorUrls[0].lang)}
                      disabled={llmTextState === "working"}
                    >
                      <span>{llmTextState === "working" ? <i className="button-spinner mini" aria-hidden="true" /> : null}LLM.txt</span>
                      <strong>
                        {llmTextState === "copied"
                          ? t("common.copied")
                          : progress.llmTexts.some((item) => item.lang === progress.mirrorUrls[0]?.lang)
                            ? t("common.copyLlm")
                            : t("common.generateLlm")}
                      </strong>
                    </button>
                    <span className="llm-copy-feedback" role="status" aria-live="polite">
                      {llmTextState === "copied" ? t("common.copiedToClipboard") : ""}
                    </span>
                  </div>
                ) : null}
                <button className="ghost-button loading-button" type="button" onClick={refreshSite} disabled={refreshing}>
                  {refreshing ? <span className="button-spinner" aria-hidden="true" /> : null}
                  {refreshing ? t("detail.refreshing") : t("detail.incremental")}
                </button>
                {(counts?.failed ?? 0) > 0 ? (
                  <button className="ghost-button loading-button" type="button" onClick={retryFailedPages} disabled={retryingFailed}>
                    {retryingFailed ? <span className="button-spinner" aria-hidden="true" /> : null}
                    {retryingFailed ? t("detail.retrying") : t("detail.retryFailed")}
                  </button>
                ) : null}
              </div>
              {progress.site.last_error ? <p className="card-error">{progress.site.last_error}</p> : null}
              {error ? <p className="error-text">{error}</p> : null}
            </section>

            <div className="detail-layout detail-page-layout">
              <div className="page-progress-card">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">{t("detail.pagesEyebrow")}</p>
                    <h2>{t("detail.pagesTitle")}</h2>
                  </div>
                  <span className="detail-count">
                    {pageCounts[pageFilter]} / {pageCounts.all} {t("common.pages")}
                  </span>
                </div>
                <div className="detail-toolbar">
                  <div className="filter-tabs" aria-label={t("detail.pagesTitle")}>
                    {[
                      ["all", t("detail.filter.all")],
                      ["active", t("detail.filter.active")],
                      ["failed", t("detail.filter.failed")],
                      ["ready", t("detail.filter.ready")]
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        className={pageFilter === value ? "active" : ""}
                        type="button"
                        onClick={() => setPageFilter(value as PageFilter)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="page-table" role="table" aria-label={t("detail.pagesTitle")}>
                  <div className="page-row page-row-head" role="row">
                    <span>{t("detail.table.page")}</span>
                    <span>{t("detail.table.status")}</span>
                    <span>{t("detail.table.lang")}</span>
                    <span>{t("detail.table.updated")}</span>
                    <span>{t("detail.table.action")}</span>
                  </div>
                  {isLoadingPages && pages.length === 0 ? (
                    <div className="empty-state compact-empty loading-inline">
                      <span className="button-spinner" aria-hidden="true" />
                      {t("common.loading")}
                    </div>
                  ) : pages.length === 0 ? (
                    <div className="empty-state compact-empty">{t("detail.emptyPages")}</div>
                  ) : (
                    pages.map((page) => {
                      const generatedLangs = page.generatedLangs;
                      const status = pageStatusLabel(page, page.generatedCount, progress.site.target_langs.length);
                      const visualStatus =
                        page.status === "ready" && page.generatedCount < progress.site.target_langs.length
                          ? "generating"
                          : page.status;
                      const primaryLang = generatedLangs[0] ?? progress.site.target_langs[0];
                      const mirrorUrl = page.mirrorUrlsByLang[primaryLang] ?? null;

                      return (
                        <div className="page-row" role="row" key={page.id}>
                          <div className="page-title-cell">
                            <strong>{page.title || page.path}</strong>
                            <a href={page.url} target="_blank" rel="noreferrer">
                              {pathFromUrl(page.url)}
                            </a>
                            {page.last_error ? <em>{page.last_error}</em> : null}
                          </div>
                          <span className={`page-status page-status-${visualStatus}`}>{status}</span>
                          <div className="lang-cell">
                            {progress.site.target_langs.map((lang) => {
                              const langMirrorUrl = page.mirrorUrlsByLang[lang];
                              return langMirrorUrl ? (
                                <a
                                  key={lang}
                                  className="lang-pill done"
                                  href={langMirrorUrl}
                                  aria-label={`${t("detail.open")} ${lang}`}
                                >
                                  {lang}
                                </a>
                              ) : (
                                <span key={lang} className="lang-pill disabled" aria-disabled="true">
                                  {lang}
                                </span>
                              );
                            })}
                          </div>
                          <div className="page-time-cell">
                            <span>{formatTime(page.updated_at, locale)}</span>
                          </div>
                          <div className="page-action-cell">
                            {mirrorUrl ? (
                              <a className="page-open-link" href={mirrorUrl}>
                                {t("detail.open")}
                              </a>
                            ) : null}
                            {page.status === "failed" ? (
                              <button
                                className="ghost-button compact-button loading-button"
                                type="button"
                                onClick={() => retrySinglePage(page.id)}
                                disabled={retryingPageId === page.id}
                              >
                                {retryingPageId === page.id ? <span className="button-spinner" aria-hidden="true" /> : null}
                                {retryingPageId === page.id ? t("detail.retrying") : t("detail.retry")}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                <div ref={loadMorePagesRef} className="load-more-sentinel detail-load-more" aria-busy={isLoadingMorePages ? "true" : undefined}>
                  {isLoadingMorePages ? (
                    <span className="loading-inline">
                      <span className="button-spinner" aria-hidden="true" />
                      {t("common.loading")}
                    </span>
                  ) : !isLoadingPages && pages.length > 0 && !nextPageCursor ? (
                    <span>{t("common.noMore")}</span>
                  ) : null}
                </div>
              </div>

              <aside className="event-panel" aria-label={t("detail.events")}>
                <h3>{t("detail.events")}</h3>
                {recentEvents.length === 0 ? (
                  <p className="muted-text">{t("detail.noEvents")}</p>
                ) : (
                  <ol className="event-list">
                    {recentEvents.map((event) => (
                      <li key={event.id} className={`event-${event.level}`}>
                        <time>{formatTime(event.created_at, locale)}</time>
                        <strong>{event.message}</strong>
                        <span>{eventText(event)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </aside>
            </div>
          </>
        )}
      </section>
      <SiteFooter />
    </main>
  );
}

function DetailLanguageVisitPill({ progress }: { progress: SiteProgress }) {
  const { t } = useI18n();
  if (progress.mirrorUrls.length === 0) {
    return null;
  }

  return (
    <div className="detail-language-links" aria-label={t("common.openTranslatedLanguage")}>
      {progress.mirrorUrls.map((mirror) => (
        <a key={mirror.lang} href={mirror.url}>
          {mirror.lang.toUpperCase()}
        </a>
      ))}
    </div>
  );
}

function DetailPageSkeleton() {
  return (
    <div className="detail-skeleton" aria-busy="true" aria-live="polite">
      <div className="dashboard-header detail-hero">
        <div>
          <span className="skeleton-block skeleton-kicker" />
          <span className="skeleton-block skeleton-hero-title" />
          <span className="skeleton-block skeleton-line short" />
        </div>
        <span className="skeleton-block skeleton-pill wide" />
      </div>
      <section className="projects-panel detail-overview skeleton-card">
        <span className="skeleton-block skeleton-line" />
        <div className="card-metrics">
          <span className="skeleton-block skeleton-metric" />
          <span className="skeleton-block skeleton-metric" />
          <span className="skeleton-block skeleton-metric" />
          <span className="skeleton-block skeleton-metric" />
        </div>
        <div className="project-actions">
          <span className="skeleton-block skeleton-pill" />
          <span className="skeleton-block skeleton-pill wide" />
          <span className="skeleton-block skeleton-pill wide" />
        </div>
      </section>
      <div className="detail-layout detail-page-layout">
        <div className="page-progress-card skeleton-card">
          <span className="skeleton-block skeleton-title" />
          <span className="skeleton-block skeleton-page-row" />
          <span className="skeleton-block skeleton-page-row" />
          <span className="skeleton-block skeleton-page-row" />
        </div>
        <aside className="event-panel skeleton-card">
          <span className="skeleton-block skeleton-title" />
          <span className="skeleton-block skeleton-line" />
          <span className="skeleton-block skeleton-line short" />
        </aside>
      </div>
    </div>
  );
}

function SiteFavicon({ progress }: { progress: SiteProgress }) {
  const [failed, setFailed] = useState(false);
  const fallback = progress.site.slug.slice(0, 1).toUpperCase();
  if (!progress.site.faviconUrl || failed) {
    return <span className="favicon-tile favicon-large">{fallback}</span>;
  }

  return (
    <span className="favicon-tile favicon-large" aria-hidden="true">
      <img src={progress.site.faviconUrl} alt="" onError={() => setFailed(true)} />
    </span>
  );
}
