"use client";

import { useEffect, useMemo, useState } from "react";
import { GitHubLink } from "./components/GitHubLink";
import { MirrorSearch } from "./components/MirrorSearch";
import { SiteFooter } from "./components/SiteFooter";
import { LocaleSwitcher, useI18n } from "./i18n";

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
  faviconUrl: string | null;
  mirrorUrls: Array<{ lang: string; url: string }>;
  llmTexts: Array<{ lang: string; page_count: number; generated_at: string; updated_at: string }>;
  upvote_count: number;
  downvote_count: number;
  vote_score: number;
  user_vote: -1 | 0 | 1;
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

function formatTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function progressFor(site: SiteCard): number {
  if (site.status === "ready") {
    return 100;
  }

  const expected = Math.max(site.discovered_count * site.target_langs.length, 1);
  return Math.min(100, Math.round((site.generated_count / expected) * 100));
}

export default function PlazaPage() {
  const { locale, t } = useI18n();
  const [sites, setSites] = useState<SiteCard[]>([]);
  const [voterId, setVoterId] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [votingSiteIds, setVotingSiteIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  function ensureVoterId(): string {
    const existing = window.localStorage.getItem("1doc:voter-id");
    if (existing) {
      return existing;
    }

    const next = crypto.randomUUID();
    window.localStorage.setItem("1doc:voter-id", next);
    return next;
  }

  async function loadSites(activeVoterId = voterId, options: { silent?: boolean } = {}) {
    if (!options.silent && !isLoading) {
      setIsRefreshing(true);
    }

    try {
      const query = activeVoterId ? `?voterId=${encodeURIComponent(activeVoterId)}` : "";
      const response = await fetch(`/api/sites${query}`, { cache: "no-store" });
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
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    const id = ensureVoterId();
    setVoterId(id);
    loadSites(id);
    const timer = window.setInterval(() => loadSites(id, { silent: true }), 8000);
    return () => window.clearInterval(timer);
  }, []);

  async function vote(site: SiteCard, value: -1 | 1) {
    const id = voterId || ensureVoterId();
    setVoterId(id);
    const nextValue = site.user_vote === value ? 0 : value;
    const previous = site;
    setVotingSiteIds((current) => new Set(current).add(site.id));

    setSites((current) =>
      current.map((candidate) =>
        candidate.id === site.id
          ? {
              ...candidate,
              user_vote: nextValue,
              upvote_count: candidate.upvote_count + (site.user_vote === 1 ? -1 : 0) + (nextValue === 1 ? 1 : 0),
              downvote_count: candidate.downvote_count + (site.user_vote === -1 ? -1 : 0) + (nextValue === -1 ? 1 : 0),
              vote_score:
                candidate.vote_score -
                (site.user_vote === 1 ? 1 : site.user_vote === -1 ? -1 : 0) +
                (nextValue === 1 ? 1 : nextValue === -1 ? -1 : 0)
            }
          : candidate
      )
    );

    try {
      const response = await fetch(`/api/sites/${site.slug}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voterId: id, value: nextValue })
      });
      const payload = (await response.json()) as Partial<SiteCard> & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || t("common.loadFailed"));
      }
      setSites((current) =>
        current
          .map((candidate) =>
            candidate.id === site.id
              ? {
                  ...candidate,
                  upvote_count: payload.upvote_count ?? candidate.upvote_count,
                  downvote_count: payload.downvote_count ?? candidate.downvote_count,
                  vote_score: payload.vote_score ?? candidate.vote_score,
                  user_vote: payload.user_vote ?? candidate.user_vote
                }
              : candidate
          )
          .sort(
            (a, b) =>
              b.vote_score - a.vote_score ||
              b.upvote_count - a.upvote_count ||
              b.generated_count - a.generated_count ||
              b.updated_at.localeCompare(a.updated_at)
          )
      );
    } catch (voteError) {
      setSites((current) => current.map((candidate) => (candidate.id === site.id ? previous : candidate)));
      setError(voteError instanceof Error ? voteError.message : t("common.loadFailed"));
    } finally {
      setVotingSiteIds((current) => {
        const next = new Set(current);
        next.delete(site.id);
        return next;
      });
    }
  }

  const readySites = useMemo(() => sites.filter((site) => site.mirrorUrls.length > 0), [sites]);
  const activeSites = useMemo(
    () => sites.filter((site) => site.status === "queued" || site.status === "discovering" || site.status === "generating"),
    [sites]
  );
  const failedSites = useMemo(() => sites.filter((site) => site.status === "failed"), [sites]);

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
    <main className="plaza-shell">
      <nav className="topbar" aria-label="1Doc">
        <a className="brand-lockup" href="/">
          <img src="/1doc-icon.png" alt="" aria-hidden="true" />
          <strong>1Doc</strong>
        </a>
        <div className="topbar-actions">
          <MirrorSearch />
          <a className="nav-link active" href="/">
            {t("nav.plaza")}
          </a>
          <a className="nav-link" href="/submit">
            {t("nav.submit")}
          </a>
          <LocaleSwitcher />
          <GitHubLink />
        </div>
      </nav>

      <section className="plaza-hero" aria-labelledby="plaza-title">
        <div className="hero-copy">
          <p className="eyebrow">{t("plaza.eyebrow")}</p>
          <h1 id="plaza-title">{t("plaza.title")}</h1>
          <p className="summary">{t("plaza.summary")}</p>
        </div>
        <div className="hero-ledger" aria-label={t("common.stats")}>
          <div>
            <strong>{readySites.length}</strong>
            <span>{t("plaza.readyStat")}</span>
          </div>
          <div>
            <strong>{activeSites.length}</strong>
            <span>{t("plaza.activeStat")}</span>
          </div>
          <div>
            <strong>{failedSites.length}</strong>
            <span>{t("plaza.failedStat")}</span>
          </div>
        </div>
      </section>

      {error ? <p className="error-text plaza-error">{error}</p> : null}

      {activeSites.length > 0 ? (
        <section className="mirror-grid-section" aria-labelledby="active-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{t("common.active")}</p>
              <h2 id="active-title">{t("plaza.activeTitle")}</h2>
            </div>
          </div>
          <div className="mirror-grid">
            {activeSites.slice(0, 3).map((site) => (
              <article className="mirror-card" key={site.id}>
                <div className="mirror-card-top">
                  <div className="mirror-title-row">
                    <SiteFavicon site={site} />
                    <div>
                    <p>{hostname(site.entry_url)}</p>
                    <h3>{siteDisplayName(site)}</h3>
                    </div>
                  </div>
                  <div className="mirror-card-badges">
                    <LlmTextButton
                      site={site}
                      compact
                      onGenerated={(llmText) => {
                        setSites((current) =>
                          current.map((candidate) =>
                            candidate.id === site.id
                              ? {
                                  ...candidate,
                                  llmTexts: [
                                    ...candidate.llmTexts.filter((item) => item.lang !== llmText.lang),
                                    llmText
                                  ]
                                }
                              : candidate
                          )
                        );
                      }}
                      onError={setError}
                    />
                    <span className={`status-pill status-${site.status}`}>{statusLabel(site.status)}</span>
                  </div>
                </div>
                <div className="meter compact" aria-label={t("common.generationProgress", { progress: progressFor(site) })}>
                  <span style={{ width: `${progressFor(site)}%` }} />
                </div>
                <div className="mirror-meta">
                  <span>{site.discovered_count} {t("common.pages")}</span>
                  <span>{site.generated_count} {t("common.snapshots")}</span>
                  <span>{progressFor(site)}%</span>
                </div>
                <div className="mirror-actions">
                  <VoteControls
                    site={site}
                    onVote={vote}
                    busy={votingSiteIds.has(site.id)}
                    upvoteLabel={t("common.upvote")}
                    downvoteLabel={t("common.downvote")}
                  />
                  <a className="primary-link mirror-visit-link" href={`/sites/${site.slug}`}>
                    {t("common.progress")}
                  </a>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="mirror-grid-section" aria-labelledby="ready-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{t("plaza.readyEyebrow")}</p>
            <h2 id="ready-title">{t("plaza.readyTitle")}</h2>
          </div>
          <button className="ghost-button loading-button" type="button" onClick={() => loadSites()} disabled={isRefreshing}>
            {isRefreshing ? <span className="button-spinner" aria-hidden="true" /> : null}
            {isRefreshing ? t("detail.refreshing") : t("common.refresh")}
          </button>
        </div>

        {isLoading ? (
          <div className="mirror-grid" aria-busy="true">
            <MirrorCardSkeleton />
            <MirrorCardSkeleton />
            <MirrorCardSkeleton />
          </div>
        ) : readySites.length === 0 ? (
          <div className="empty-state">{t("plaza.empty")}</div>
        ) : (
          <div className="mirror-grid">
            {readySites.map((site) => (
              <article className="mirror-card" key={site.id}>
                <div className="mirror-card-top">
                  <div className="mirror-title-row">
                    <SiteFavicon site={site} />
                    <div>
                    <p>{hostname(site.entry_url)}</p>
                    <h3>{siteDisplayName(site)}</h3>
                    </div>
                  </div>
                  <div className="mirror-card-badges">
                    <LlmTextButton
                      site={site}
                      compact
                      onGenerated={(llmText) => {
                        setSites((current) =>
                          current.map((candidate) =>
                            candidate.id === site.id
                              ? {
                                  ...candidate,
                                  llmTexts: [
                                    ...candidate.llmTexts.filter((item) => item.lang !== llmText.lang),
                                    llmText
                                  ]
                                }
                              : candidate
                          )
                        );
                      }}
                      onError={setError}
                    />
                    <span className={`status-pill status-${site.status}`}>{statusLabel(site.status)}</span>
                  </div>
                </div>
                <p className="source-url">{site.entry_url}</p>
                <div className="mirror-meta">
                  <span>{site.discovered_count} {t("common.pages")}</span>
                  <span>{site.generated_count} {t("common.snapshots")}</span>
                  <span>{site.target_langs.join(", ")}</span>
                </div>
                <div className="mirror-actions">
                  <VoteControls
                    site={site}
                    onVote={vote}
                    busy={votingSiteIds.has(site.id)}
                    upvoteLabel={t("common.upvote")}
                    downvoteLabel={t("common.downvote")}
                  />
                  <LanguageVisitPill site={site} />
                  <a className="ghost-button" href={`/sites/${site.slug}`}>
                    {t("common.details")}
                  </a>
                  <a className="ghost-button" href={site.entry_url} target="_blank" rel="noreferrer">
                    {t("common.original")}
                  </a>
                  <span>{t("common.updated")} {formatTime(site.updated_at, locale)}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <SiteFooter />
    </main>
  );
}

function VoteControls({
  site,
  onVote,
  busy,
  upvoteLabel,
  downvoteLabel
}: {
  site: SiteCard;
  onVote: (site: SiteCard, value: -1 | 1) => void;
  busy?: boolean;
  upvoteLabel: string;
  downvoteLabel: string;
}) {
  const { t } = useI18n();

  return (
    <div className={`vote-controls${busy ? " is-busy" : ""}`} aria-label={t("common.votes")} aria-busy={busy ? "true" : undefined}>
      <button
        className={site.user_vote === 1 ? "active" : ""}
        type="button"
        onClick={() => onVote(site, 1)}
        disabled={busy}
        aria-pressed={site.user_vote === 1}
        title={upvoteLabel}
      >
        <span aria-hidden="true">↑</span>
        <em>{upvoteLabel}</em>
        <strong>{site.upvote_count}</strong>
      </button>
      <button
        className={site.user_vote === -1 ? "active" : ""}
        type="button"
        onClick={() => onVote(site, -1)}
        disabled={busy}
        aria-pressed={site.user_vote === -1}
        title={downvoteLabel}
      >
        <span aria-hidden="true">↓</span>
        <em>{downvoteLabel}</em>
        <strong>{site.downvote_count}</strong>
      </button>
    </div>
  );
}

function LanguageVisitPill({ site }: { site: SiteCard }) {
  const { t } = useI18n();
  const primaryMirror = site.mirrorUrls[0];
  if (!primaryMirror) {
    return null;
  }

  return (
    <label className="locale-switcher document-language-switcher" aria-label={t("common.openTranslatedLanguage")}>
      <span>{primaryMirror.lang.toUpperCase()}</span>
      <select
        defaultValue=""
        onChange={(event) => {
          const next = site.mirrorUrls.find((mirror) => mirror.lang === event.target.value);
          if (next) {
            window.location.href = next.url;
          }
        }}
      >
        <option value="" disabled>
          {primaryMirror.lang}
        </option>
        {site.mirrorUrls.map((mirror) => (
          <option key={mirror.lang} value={mirror.lang}>
            {mirror.lang.toUpperCase()}
          </option>
        ))}
      </select>
    </label>
  );
}

function LlmTextButton({
  site,
  onGenerated,
  onError,
  compact = false
}: {
  site: SiteCard;
  onGenerated: (llmText: { lang: string; page_count: number; generated_at: string; updated_at: string }) => void;
  onError: (message: string | null) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "working" | "copied">("idle");
  const lang = site.mirrorUrls[0]?.lang ?? site.target_langs[0];
  const hasLlmText = Boolean(site.llmTexts.find((item) => item.lang === lang));

  async function copyLlmText() {
    if (!lang || state === "working") {
      return;
    }

    setState("working");
    onError(null);
    try {
      const response = hasLlmText
        ? await fetch(`/api/sites/${site.slug}/llm-text?lang=${encodeURIComponent(lang)}`, { cache: "no-store" })
        : await fetch(`/api/sites/${site.slug}/llm-text`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ lang })
          });
      const payload = (await response.json()) as {
        content?: string;
        llmText?: { content: string; lang: string; page_count: number; generated_at: string; updated_at: string };
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || t("common.copyFailed"));
      }

      const content = payload.content ?? payload.llmText?.content;
      if (!content) {
        throw new Error(t("common.copyFailed"));
      }
      await navigator.clipboard.writeText(content);
      if (payload.llmText) {
        onGenerated(payload.llmText);
      }
      setState("copied");
      window.setTimeout(() => setState("idle"), 1500);
    } catch (copyError) {
      setState("idle");
      onError(copyError instanceof Error ? copyError.message : t("common.copyFailed"));
    }
  }

  if (!lang || site.status !== "ready") {
    return null;
  }

  return (
    <div className="llm-copy-wrap">
      <button className={`llm-copy-button${compact ? " compact" : ""}`} type="button" onClick={copyLlmText} disabled={state === "working"}>
        <span>{state === "working" ? <i className="button-spinner mini" aria-hidden="true" /> : null}LLM.txt</span>
        {compact ? null : (
          <strong>{state === "copied" ? t("common.copied") : hasLlmText ? t("common.copyLlm") : t("common.generateLlm")}</strong>
        )}
      </button>
      <span className={`llm-copy-feedback${compact ? " compact" : ""}`} role="status" aria-live="polite">
        {state === "copied" ? t("common.copiedToClipboard") : ""}
      </span>
    </div>
  );
}

function MirrorCardSkeleton() {
  return (
    <article className="mirror-card skeleton-card" aria-hidden="true">
      <div className="mirror-card-top">
        <div className="mirror-title-row">
          <span className="skeleton-block skeleton-icon" />
          <div>
            <span className="skeleton-block skeleton-kicker" />
            <span className="skeleton-block skeleton-title" />
          </div>
        </div>
        <span className="skeleton-block skeleton-pill" />
      </div>
      <span className="skeleton-block skeleton-line" />
      <div className="mirror-meta">
        <span className="skeleton-block skeleton-chip" />
        <span className="skeleton-block skeleton-chip" />
        <span className="skeleton-block skeleton-chip" />
      </div>
      <div className="mirror-actions">
        <span className="skeleton-block skeleton-pill" />
        <span className="skeleton-block skeleton-pill wide" />
      </div>
    </article>
  );
}

function SiteFavicon({ site }: { site: SiteCard }) {
  if (!site.faviconUrl) {
    return <span className="favicon-tile">{hostname(site.entry_url).slice(0, 1).toUpperCase()}</span>;
  }

  return (
    <span className="favicon-tile" aria-hidden="true">
      <img src={site.faviconUrl} alt="" onError={(event) => event.currentTarget.remove()} />
    </span>
  );
}
