"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function loadSites() {
    setIsLoading(true);
    try {
      const response = await fetch("/api/sites", { cache: "no-store" });
      const payload = (await response.json()) as { sites?: SiteCard[]; error?: string };
      if (!response.ok || !payload.sites) {
        throw new Error(payload.error || t("common.loadFailed"));
      }
      setSites(payload.sites);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("common.loadFailed"));
    } finally {
      setIsLoading(false);
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

    loadSites();
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const results = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const sorted = [...sites].sort((a, b) => {
      const aReady = a.status === "ready" ? 0 : 1;
      const bReady = b.status === "ready" ? 0 : 1;
      return aReady - bReady || b.vote_score - a.vote_score || b.upvote_count - a.upvote_count || b.generated_count - a.generated_count;
    });

    if (!keyword) {
      return sorted.slice(0, 8);
    }

    return sorted
      .filter((site) => {
        const haystack = [siteDisplayName(site), site.slug, site.entry_url, hostname(site.entry_url), site.target_langs.join(" ")]
          .join(" ")
          .toLowerCase();
        return haystack.includes(keyword);
      })
      .slice(0, 12);
  }, [query, sites]);

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

            <div className={`spotlight-results${isLoading ? " is-loading" : ""}`} aria-busy={isLoading ? "true" : undefined}>
              {isLoading ? (
                <div className="spotlight-empty loading-inline">
                  <span className="button-spinner" aria-hidden="true" />
                  {t("search.loading")}
                </div>
              ) : null}
              {error ? <div className="spotlight-empty">{error}</div> : null}
              {!isLoading && !error && results.length === 0 ? (
                <div className="spotlight-empty">{t("search.empty")}</div>
              ) : null}
              {results.map((site) => (
                <a className="spotlight-result" href={resultHref(site)} key={site.id}>
                  <SiteFavicon site={site} />
                  <div>
                    <strong>{siteDisplayName(site)}</strong>
                    <span>{hostname(site.entry_url)} · {site.target_langs.join(", ")}</span>
                  </div>
                  <em>{site.status === "ready" ? t("search.open") : statusLabel(site.status)}</em>
                </a>
              ))}
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
