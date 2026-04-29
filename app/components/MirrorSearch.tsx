"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";

type SiteStatus = "queued" | "discovering" | "generating" | "ready" | "failed";

type SiteCard = {
  id: string;
  slug: string;
  entry_url: string;
  target_langs: string[];
  status: SiteStatus;
  discovered_count: number;
  generated_count: number;
  failed_count: number;
  faviconUrl: string | null;
  mirrorUrls: Array<{ lang: string; url: string }>;
  upvote_count: number;
  vote_score: number;
};

function hostname(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function siteDisplayName(site: SiteCard): string {
  return hostname(site.entry_url);
}

function resultHref(site: SiteCard): string {
  return site.mirrorUrls[0]?.url ?? `/sites/${site.slug}`;
}

export function MirrorSearch() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sites, setSites] = useState<SiteCard[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const nextCursorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);

  function updateNextCursor(value: string | null) {
    nextCursorRef.current = value;
    setNextCursor(value);
  }

  function appendSites(current: SiteCard[], incoming: SiteCard[]): SiteCard[] {
    const currentIds = new Set(current.map((site) => site.id));
    return [...current, ...incoming.filter((site) => !currentIds.has(site.id))];
  }

  async function loadSites(keyword: string, options: { append?: boolean; cursor?: string | null; signal?: AbortSignal } = {}) {
    if (options.append) {
      const cursor = options.cursor ?? nextCursorRef.current;
      if (!cursor || loadingMoreRef.current) {
        return;
      }
      loadingMoreRef.current = true;
      setIsLoadingMore(true);
    } else {
      setIsLoading(true);
    }
    try {
      const params = new URLSearchParams();
      if (keyword.trim()) {
        params.set("q", keyword.trim());
      }
      const cursor = options.append ? options.cursor ?? nextCursorRef.current : options.cursor;
      if (cursor) {
        params.set("cursor", cursor);
      }
      const response = await fetch(`/api/sites/search${params.toString() ? `?${params.toString()}` : ""}`, {
        cache: "no-store",
        signal: options.signal
      });
      const payload = (await response.json()) as { sites?: SiteCard[]; nextCursor?: string | null; error?: string };
      if (!response.ok || !payload.sites) {
        throw new Error(payload.error || t("common.loadFailed"));
      }
      setSites((current) => (options.append ? appendSites(current, payload.sites ?? []) : payload.sites ?? []));
      updateNextCursor(payload.nextCursor ?? null);
      setError(null);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") {
        return;
      }
      setError(loadError instanceof Error ? loadError.message : t("common.loadFailed"));
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
      if (options.append) {
        loadingMoreRef.current = false;
      }
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    window.setTimeout(() => inputRef.current?.focus(), 0);

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      updateNextCursor(null);
      void loadSites(query, { signal: controller.signal });
    }, query.trim() ? 180 : 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open, query]);

  useEffect(() => {
    const node = resultsRef.current;
    if (!open || query.trim() || !node || !nextCursor || isLoading || isLoadingMore) {
      return;
    }

    const resultsNode = node;
    function onScroll() {
      const cursor = nextCursorRef.current;
      if (resultsNode.scrollTop + resultsNode.clientHeight >= resultsNode.scrollHeight - 80 && cursor && !loadingMoreRef.current) {
        void loadSites("", { append: true, cursor });
      }
    }

    resultsNode.addEventListener("scroll", onScroll);
    onScroll();
    return () => resultsNode.removeEventListener("scroll", onScroll);
  }, [open, query, nextCursor, isLoading, isLoadingMore]);

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

  return (
    <>
      <button className="search-trigger" type="button" onClick={() => setOpen(true)} aria-label={t("nav.search")}>
        <span>{t("nav.search")}</span>
        <kbd>⌘K</kbd>
      </button>

      {open ? (
        <div className="spotlight-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <section
            className="spotlight-panel"
            aria-label={t("nav.search")}
            role="dialog"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="spotlight-input-row">
              <input
                ref={inputRef}
                type="search"
                placeholder={t("search.placeholder")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <kbd>Esc</kbd>
            </div>

            <div
              ref={resultsRef}
              className={`spotlight-results${isLoading ? " is-loading" : ""}`}
              aria-busy={isLoading || isLoadingMore ? "true" : undefined}
            >
              {isLoading ? (
                <div className="spotlight-empty loading-inline">
                  <span className="button-spinner" aria-hidden="true" />
                  {t("search.loading")}
                </div>
              ) : null}
              {error ? <div className="spotlight-empty">{error}</div> : null}
              {!isLoading && !error && sites.length === 0 ? (
                <div className="spotlight-empty">{t("search.empty")}</div>
              ) : null}
              {sites.map((site) => (
                <a className="spotlight-result" href={resultHref(site)} key={site.id}>
                  <SiteFavicon site={site} />
                  <div>
                    <strong>{siteDisplayName(site)}</strong>
                    <span>{hostname(site.entry_url)} · {site.target_langs.join(", ")}</span>
                  </div>
                  <em>{site.status === "ready" ? t("search.open") : statusLabel(site.status)}</em>
                </a>
              ))}
              {isLoadingMore ? (
                <div className="spotlight-load-more loading-inline">
                  <span className="button-spinner" aria-hidden="true" />
                  {t("common.loading")}
                </div>
              ) : !isLoading && sites.length > 0 && !nextCursor ? (
                <div className="spotlight-load-more">{t("common.noMore")}</div>
              ) : null}
            </div>

            <div className="spotlight-footer">
              <a href="/submit">{t("search.submit")}</a>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function SiteFavicon({ site }: { site: SiteCard }) {
  const [failed, setFailed] = useState(false);
  const fallback = hostname(site.entry_url).slice(0, 1).toUpperCase();

  if (!site.faviconUrl || failed) {
    return <span className="favicon-tile">{fallback}</span>;
  }

  return (
    <span className="favicon-tile" aria-hidden="true">
      <img src={site.faviconUrl} alt="" onError={() => setFailed(true)} />
    </span>
  );
}
