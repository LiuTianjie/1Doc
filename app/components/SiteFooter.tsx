"use client";

import { useI18n } from "../i18n";

const repositoryUrl = "https://github.com/LiuTianjie/1Doc";
const sponsorUrl = "https://ifdian.net/a/itool/plan";

export function SiteFooter() {
  const { t } = useI18n();

  return (
    <footer className="site-footer">
      <div>
        <strong>1Doc</strong>
        <span>{t("footer.tagline")}</span>
      </div>
      <nav aria-label={t("footer.aria")}>
        <a href="/">{t("nav.plaza")}</a>
        <a href="/submit">{t("nav.submit")}</a>
        <a href={repositoryUrl} target="_blank" rel="noreferrer">
          {t("footer.github")}
        </a>
        <a className="sponsor-link" href={sponsorUrl} target="_blank" rel="noreferrer">
          {t("footer.sponsor")}
        </a>
      </nav>
    </footer>
  );
}
