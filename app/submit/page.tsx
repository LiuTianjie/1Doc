"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { GitHubLink } from "../components/GitHubLink";
import { MirrorSearch } from "../components/MirrorSearch";
import { SiteFooter } from "../components/SiteFooter";
import { LocaleSwitcher, localeLabels, locales, useI18n } from "../i18n";

const languages = locales.map((value) => ({ value, label: localeLabels[value] }));

type SiteStatus = "queued" | "discovering" | "generating" | "ready" | "failed";

type SiteCard = {
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
  latestEvent: null | {
    level: "info" | "error";
    message: string;
    metadata: Record<string, unknown>;
    created_at: string;
  };
  mirrorUrls: Array<{ lang: string; url: string }>;
};

type SourcePageDetail = {
  id: string;
  url: string;
  path: string;
  title: string | null;
  html_hash: string | null;
  status: "queued" | "fetching" | "translating" | "publishing" | "ready" | "skipped" | "failed";
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
  site: Omit<SiteCard, "latestEvent" | "mirrorUrls">;
  pages: SourcePageDetail[];
  mirroredPages: MirroredPageDetail[];
  events: JobEventDetail[];
  mirrorUrls: Array<{ lang: string; url: string }>;
};

type SubmitResult = {
  reused: boolean;
  generationMode: "queued" | "inline" | "skipped";
  site: {
    slug: string;
    status: SiteStatus;
    entry_url: string;
  };
  mirrorUrl: string | null;
};

type PageFilter = "all" | "active" | "failed" | "ready";
type TFunction = ReturnType<typeof useI18n>["t"];

function statusLabel(status: SiteStatus, t: TFunction): string {
  const labels: Record<SiteStatus, string> = {
    queued: t("status.queued"),
    discovering: t("status.discovering"),
    generating: t("status.generating"),
    ready: t("status.ready"),
    failed: t("status.failed")
  };
  return labels[status];
}

function progressFor(site: SiteCard): number {
  if (site.status === "ready") {
    return 100;
  }

  const expected = Math.max(site.discovered_count * site.target_langs.length, 1);
  return Math.min(100, Math.round((site.generated_count / expected) * 100));
}

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

function eventText(event: NonNullable<SiteCard["latestEvent"]>): string {
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

function pathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function isActive(status: SiteStatus): boolean {
  return status === "queued" || status === "discovering" || status === "generating";
}

function pageStatusLabel(page: SourcePageDetail, generatedCount: number, targetLangCount: number, t: TFunction): string {
  if (page.status === "failed") {
    return t("status.failed");
  }
  if (page.status === "fetching") {
    return t("pageStatus.fetching");
  }
  if (page.status === "queued") {
    return t("pageStatus.queued");
  }
  if (page.status === "translating") {
    return t("pageStatus.translating");
  }
  if (page.status === "publishing") {
    return t("pageStatus.publishing");
  }
  if (page.status === "skipped") {
    return t("pageStatus.skipped");
  }
  if (generatedCount >= targetLangCount) {
    return t("pageStatus.ready");
  }
  if (generatedCount > 0) {
    return t("pageStatus.partial");
  }
  return t("pageStatus.translating");
}

export default function SubmitPage() {
  const { locale, t } = useI18n();
  const [entryUrl, setEntryUrl] = useState("");
  const [targetLangs, setTargetLangs] = useState(["zh"]);
  const [pageLimit, setPageLimit] = useState(300);
  const [sites, setSites] = useState<SiteCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingSites, setIsLoadingSites] = useState(true);
  const [refreshingSlug, setRefreshingSlug] = useState<string | null>(null);
  const [retryingSlug, setRetryingSlug] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [isProgressOpen, setIsProgressOpen] = useState(false);
  const [siteProgress, setSiteProgress] = useState<SiteProgress | null>(null);
  const [isLoadingProgress, setIsLoadingProgress] = useState(false);
  const [pageFilter, setPageFilter] = useState<PageFilter>("all");
  const [retryingPageId, setRetryingPageId] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);

  const activeSites = useMemo(() => sites.filter((site) => isActive(site.status)), [sites]);
  const readySites = useMemo(() => sites.filter((site) => site.status === "ready"), [sites]);
  const failedSites = useMemo(() => sites.filter((site) => site.status === "failed"), [sites]);

  async function loadSites() {
    try {
      const response = await fetch("/api/sites", { cache: "no-store" });
      const payload = (await response.json()) as { sites?: SiteCard[]; error?: string };
      if (!response.ok || !payload.sites) {
        throw new Error(payload.error || t("submit.loadFailed"));
      }
      setSites(payload.sites);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("submit.loadFailed"));
    } finally {
      setIsLoadingSites(false);
    }
  }

  useEffect(() => {
    loadSites();
    const timer = window.setInterval(loadSites, 3000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get("url");
    const lang = params.get("lang");
    if (url) {
      setEntryUrl(url);
    }
    if (lang && /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(lang)) {
      setTargetLangs([lang.toLowerCase()]);
    }
  }, []);

  async function loadSiteProgress(slug: string) {
    setIsLoadingProgress(true);
    try {
      const response = await fetch(`/api/sites/${slug}`, { cache: "no-store" });
      const payload = (await response.json()) as SiteProgress | { error?: string };
      if (!response.ok) {
        const errorPayload = payload as { error?: string };
        throw new Error(errorPayload.error || t("submit.progressLoadFailed"));
      }
      setSiteProgress(payload as SiteProgress);
      setError(null);
    } catch (progressError) {
      setError(progressError instanceof Error ? progressError.message : t("submit.progressLoadFailed"));
    } finally {
      setIsLoadingProgress(false);
    }
  }

  useEffect(() => {
    if (!selectedSlug || !isProgressOpen) {
      setSiteProgress(null);
      return;
    }

    loadSiteProgress(selectedSlug);
    const timer = window.setInterval(() => loadSiteProgress(selectedSlug), 2500);
    return () => window.clearInterval(timer);
  }, [selectedSlug, isProgressOpen]);

  useEffect(() => {
    if (!isProgressOpen) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeProgress();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isProgressOpen]);

  function toggleLang(lang: string) {
    setTargetLangs((current) => {
      if (current.includes(lang)) {
        return current.length === 1 ? current : current.filter((value) => value !== lang);
      }
      return [...current, lang];
    });
  }

  async function createMirror(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/sites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entryUrl,
          targetLangs,
          pageLimit
        })
      });
      const payload = (await response.json()) as SubmitResult & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || t("submit.createFailed"));
      }
      setSubmitResult(payload);
      window.location.href = `/sites/${payload.site.slug}`;
      await loadSites();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t("submit.createFailed"));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function refreshSite(slug: string) {
    setRefreshingSlug(slug);
    setError(null);
    try {
      const response = await fetch(`/api/sites/${slug}/refresh`, {
        method: "POST"
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || t("submit.refreshFailed"));
      }
      await loadSites();
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : t("submit.refreshFailed"));
    } finally {
      setRefreshingSlug(null);
    }
  }

  async function retryFailedPages(slug: string) {
    setRetryingSlug(slug);
    setError(null);
    try {
      const response = await fetch(`/api/sites/${slug}/retry-failed`, {
        method: "POST"
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || t("submit.retryFailedPagesFailed"));
      }
      await loadSites();
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : t("submit.retryFailedPagesFailed"));
    } finally {
      setRetryingSlug(null);
    }
  }

  async function retrySinglePage(pageId: string) {
    if (!selectedSlug) {
      return;
    }

    setRetryingPageId(pageId);
    setError(null);
    try {
      const response = await fetch(`/api/sites/${selectedSlug}/pages/${pageId}/retry`, {
        method: "POST"
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || t("submit.retryPageFailed"));
      }
      await Promise.all([loadSites(), loadSiteProgress(selectedSlug)]);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : t("submit.retryPageFailed"));
    } finally {
      setRetryingPageId(null);
    }
  }

  function openProgress(slug: string) {
    setSelectedSlug(slug);
    setSiteProgress(null);
    setPageFilter("all");
    setIsProgressOpen(true);
  }

  function closeProgress() {
    setIsProgressOpen(false);
    setSiteProgress(null);
  }

  return (
    <main className="dashboard-shell">
      <section className="dashboard" aria-labelledby="page-title">
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
            <a className="nav-link active" href="/submit">
              {t("nav.submit")}
            </a>
            <LocaleSwitcher />
            <GitHubLink />
          </div>
        </nav>

        <header className="dashboard-header">
          <div>
            <p className="eyebrow">{t("submit.eyebrow")}</p>
            <h1 id="page-title">{t("submit.title")}</h1>
            <p className="summary">{t("submit.summary")}</p>
          </div>
          <div className="dashboard-stats" aria-label={t("submit.projectStats")}>
            <div>
              <strong>{activeSites.length}</strong>
              <span>{t("common.active")}</span>
            </div>
            <div>
              <strong>{readySites.length}</strong>
              <span>{t("common.complete")}</span>
            </div>
            <div>
              <strong>{failedSites.length}</strong>
              <span>{t("common.failed")}</span>
            </div>
          </div>
        </header>

        <div className="submit-grid">
          <section className="create-panel" aria-labelledby="create-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">{t("submit.formEyebrow")}</p>
                <h2 id="create-title">{t("submit.formTitle")}</h2>
              </div>
            </div>

            <form className={`mirror-form${isSubmitting ? " is-submitting" : ""}`} onSubmit={createMirror} aria-busy={isSubmitting ? "true" : undefined}>
              <label htmlFor="url">{t("submit.url")}</label>
              <input
                id="url"
                name="url"
                type="url"
                placeholder="https://docs.example.com"
                autoComplete="url"
                required
                value={entryUrl}
                onChange={(event) => setEntryUrl(event.target.value)}
                disabled={isSubmitting}
              />

              <label htmlFor="pageLimit">{t("submit.limit")}</label>
              <input
                id="pageLimit"
                min="1"
                max="1000"
                name="pageLimit"
                type="number"
                value={pageLimit}
                onChange={(event) => setPageLimit(Number(event.target.value))}
                disabled={isSubmitting}
              />

              <fieldset className="language-fieldset">
                <legend>{t("submit.langs")}</legend>
                <div className="language-grid">
                  {languages.map((language) => (
                    <button
                      key={language.value}
                      className="language-choice"
                      type="button"
                      aria-pressed={targetLangs.includes(language.value)}
                      onClick={() => toggleLang(language.value)}
                      disabled={isSubmitting}
                    >
                      <span>{language.label}</span>
                      <i aria-hidden="true">✓</i>
                    </button>
                  ))}
                </div>
              </fieldset>

              <button className="primary-button loading-button" type="submit" disabled={isSubmitting}>
                {isSubmitting ? <span className="button-spinner dark" aria-hidden="true" /> : null}
                {isSubmitting ? t("submit.checking") : t("submit.button")}
              </button>
            </form>

            {submitResult ? (
              <div className="submit-result">
                <span className={`status-pill status-${submitResult.site.status}`}>
                  {submitResult.reused ? t("submit.existing") : t("submit.newTask")}
                </span>
                <strong>{t("submit.entering")}</strong>
                <p>{submitResult.site.entry_url}</p>
              </div>
            ) : null}

            {error ? <p className="error-text">{error}</p> : null}
          </section>

          <section className="projects-panel submit-note-panel" aria-labelledby="submit-note-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">{t("submit.noteEyebrow")}</p>
                <h2 id="submit-note-title">{t("submit.noteTitle")}</h2>
              </div>
            </div>
            <div className="submit-note-list">
              <div>
                <strong>{t("submit.note1Title")}</strong>
                <span>{t("submit.note1")}</span>
              </div>
              <div>
                <strong>{t("submit.note2Title")}</strong>
                <span>{t("submit.note2")}</span>
              </div>
              <div>
                <strong>{t("submit.note3Title")}</strong>
                <span>{t("submit.note3")}</span>
              </div>
            </div>
          </section>
        </div>
      </section>
      <SiteFooter />
    </main>
  );
}

function ProjectGroup({
  title,
  sites,
  onRefresh,
  onRetryFailed,
  refreshingSlug,
  retryingSlug,
  onSelect,
  selectedSlug,
  locale
}: {
  title: string;
  sites: SiteCard[];
  onRefresh: (slug: string) => void;
  onRetryFailed: (slug: string) => void;
  refreshingSlug: string | null;
  retryingSlug: string | null;
  onSelect: (slug: string) => void;
  selectedSlug: string | null;
  locale: string;
}) {
  if (sites.length === 0) {
    return null;
  }

  return (
    <section className="project-group" aria-labelledby={`${title}-title`}>
      <h3 id={`${title}-title`}>{title}</h3>
      <div className="project-list">
        {sites.map((site) => (
          <ProjectCard
            key={site.id}
            site={site}
            onRefresh={onRefresh}
            onRetryFailed={onRetryFailed}
            refreshing={refreshingSlug === site.slug}
            retrying={retryingSlug === site.slug}
            onSelect={onSelect}
            selected={selectedSlug === site.slug}
            locale={locale}
          />
        ))}
      </div>
    </section>
  );
}

function ProjectCard({
  site,
  onRefresh,
  onRetryFailed,
  refreshing,
  retrying,
  onSelect,
  selected,
  locale
}: {
  site: SiteCard;
  onRefresh: (slug: string) => void;
  onRetryFailed: (slug: string) => void;
  refreshing: boolean;
  retrying: boolean;
  onSelect: (slug: string) => void;
  selected: boolean;
  locale: string;
}) {
  const { t } = useI18n();
  const progress = progressFor(site);
  const primaryMirror = site.mirrorUrls[0];

  return (
    <article className={`project-card${selected ? " selected" : ""}`}>
      <div className="project-card-top">
        <div className="project-title-block">
          <h4>{site.slug}</h4>
          <a href={site.entry_url} target="_blank" rel="noreferrer">
            {site.entry_url}
          </a>
        </div>
        <span className={`status-pill status-${site.status}`}>{statusLabel(site.status, t)}</span>
      </div>

      <div className="meter compact" aria-label={t("common.generationProgress", { progress })}>
        <span style={{ width: `${progress}%` }} />
      </div>

      <div className="card-metrics">
        <div>
          <strong>{site.discovered_count}</strong>
          <span>{t("common.found")}</span>
        </div>
        <div>
          <strong>{site.generated_count}</strong>
          <span>{t("common.generated")}</span>
        </div>
        <div>
          <strong>{site.failed_count}</strong>
          <span>{t("common.failed")}</span>
        </div>
        <div>
          <strong>{site.target_langs.join(", ")}</strong>
          <span>{t("common.lang")}</span>
        </div>
      </div>

      {site.last_error ? <p className="card-error">{site.last_error}</p> : null}
      {site.latestEvent ? (
        <p className={`card-event event-${site.latestEvent.level}`}>
          {eventText(site.latestEvent)}
        </p>
      ) : null}

      <div className="project-actions">
        {primaryMirror ? (
          <a className="primary-link" href={primaryMirror.url} target="_blank">
            {t("common.visitLang")}
          </a>
        ) : null}
        <button className="ghost-button" type="button" onClick={() => onSelect(site.slug)}>
          {t("submit.progressDialog")}
        </button>
        {site.failed_count > 0 ? (
          <button className="ghost-button loading-button" type="button" onClick={() => onRetryFailed(site.slug)} disabled={retrying}>
            {retrying ? <span className="button-spinner" aria-hidden="true" /> : null}
            {retrying ? t("detail.retrying") : t("detail.retryFailed")}
          </button>
        ) : null}
        <button className="ghost-button loading-button" type="button" onClick={() => onRefresh(site.slug)} disabled={refreshing}>
          {refreshing ? <span className="button-spinner" aria-hidden="true" /> : null}
          {refreshing ? t("detail.refreshing") : t("detail.incremental")}
        </button>
        <span className="updated-time">{t("submit.updatedAt", { time: formatTime(site.updated_at, locale) })}</span>
      </div>
    </article>
  );
}

function ProjectDetailPanel({
  progress,
  loading,
  pageFilter,
  onPageFilterChange,
  onClose,
  onRetryPage,
  retryingPageId
}: {
  progress: SiteProgress | null;
  loading: boolean;
  pageFilter: PageFilter;
  onPageFilterChange: (filter: PageFilter) => void;
  onClose: () => void;
  onRetryPage: (pageId: string) => void;
  retryingPageId: string | null;
}) {
  const { locale, t } = useI18n();

  if (!progress) {
    return (
      <div className="modal-backdrop" role="presentation" onClick={onClose}>
        <section className="detail-panel modal-panel loading-modal" aria-label={t("submit.progressDialog")} onClick={(event) => event.stopPropagation()}>
          <div className="modal-close-row">
            <button className="icon-button" type="button" onClick={onClose} aria-label={t("submit.closeProgress")}>
              ×
            </button>
          </div>
          <div className="empty-state compact-empty loading-inline">
            {loading ? <span className="button-spinner" aria-hidden="true" /> : null}
            {loading ? t("submit.loadingProgress") : t("submit.selectProgress")}
          </div>
        </section>
      </div>
    );
  }

  const generatedByPath = new Map<string, MirroredPageDetail[]>();
  for (const mirror of progress.mirroredPages) {
    const current = generatedByPath.get(mirror.path) ?? [];
    current.push(mirror);
    generatedByPath.set(mirror.path, current);
  }

  const filteredPages = progress.pages.filter((page) => {
    const generatedCount = generatedByPath.get(page.path)?.length ?? 0;
    if (pageFilter === "failed") {
      return page.status === "failed";
    }
    if (pageFilter === "active") {
      return page.status !== "failed" && generatedCount < progress.site.target_langs.length;
    }
    if (pageFilter === "ready") {
      return generatedCount >= progress.site.target_langs.length;
    }
    return true;
  });

  const recentEvents = progress.events.slice(-12).reverse();

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="detail-panel modal-panel"
        aria-labelledby="detail-title"
        aria-modal="true"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="detail-heading">
          <div>
            <p className="eyebrow">{t("submit.pageProgressEyebrow")}</p>
            <h2 id="detail-title">{progress.site.slug}</h2>
            <p className="detail-subtitle">{progress.site.entry_url}</p>
          </div>
          <div className="detail-actions">
            <span className={`status-pill status-${progress.site.status}`}>{statusLabel(progress.site.status, t)}</span>
            <button className="icon-button" type="button" onClick={onClose} aria-label={t("submit.closeProgress")}>
              ×
            </button>
          </div>
        </div>

        <div className="detail-layout">
          <div className="page-progress-card">
            <div className="detail-toolbar">
              <div className="filter-tabs" aria-label={t("submit.pageFilter")}>
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
                    onClick={() => onPageFilterChange(value as PageFilter)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="detail-count">
                {filteredPages.length} / {progress.pages.length} {t("common.pages")}
              </span>
            </div>

            <div className="page-table" role="table" aria-label={t("submit.pageProgressTable")}>
              <div className="page-row page-row-head" role="row">
                <span>{t("detail.table.page")}</span>
                <span>{t("detail.table.status")}</span>
                <span>{t("detail.table.lang")}</span>
                <span>{t("detail.table.updated")}</span>
                <span>{t("detail.table.action")}</span>
              </div>
              {filteredPages.length === 0 ? (
                <div className="empty-state compact-empty">{t("detail.emptyPages")}</div>
              ) : (
                filteredPages.map((page) => {
                  const generated = generatedByPath.get(page.path) ?? [];
                  const generatedLangs = generated.map((mirror) => mirror.lang);
                  const status = pageStatusLabel(page, generated.length, progress.site.target_langs.length, t);
                  const visualStatus =
                    page.status === "ready" && generated.length < progress.site.target_langs.length
                      ? "generating"
                      : page.status;
                  const primaryLang = generatedLangs[0] ?? progress.site.target_langs[0];
                  const mirrorUrl = generated.length > 0 ? `/sites/${progress.site.slug}/${primaryLang}${page.path}` : null;

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
                        {progress.site.target_langs.map((lang) => (
                          <span key={lang} className={generatedLangs.includes(lang) ? "done" : ""}>
                            {lang}
                          </span>
                        ))}
                      </div>
                      <div className="page-time-cell">
                        <span>{formatTime(page.updated_at, locale)}</span>
                        {mirrorUrl ? (
                          <a href={mirrorUrl} target="_blank">
                            {t("detail.open")}
                          </a>
                        ) : null}
                      </div>
                      <div className="page-action-cell">
                        {page.status === "failed" ? (
                          <button
                            className="ghost-button compact-button loading-button"
                            type="button"
                            onClick={() => onRetryPage(page.id)}
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
      </section>
    </div>
  );
}
