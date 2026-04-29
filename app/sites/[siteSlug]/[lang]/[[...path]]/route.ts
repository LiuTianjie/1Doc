import { getDocSiteBySlug, getMirroredPage, getSourcePage, listMirroredPages } from "@/lib/mirror/store";
import { mirrorPathCandidates, normalizeMirrorPath } from "@/lib/mirror/url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const statusMessages = {
  zh: {
    missingTitle: "文档不存在",
    missingMessage: "这个文档项目不存在或尚未创建。",
    plazaHome: "返回文档广场",
    oneDocHome: "返回 1Doc 首页",
    failedTitle: "页面生成失败",
    undiscoveredTitle: "页面未发现",
    generatingTitle: "页面正在生成",
    failedMessage: "这个页面生成失败，可以在控制台重试失败页面。",
    undiscoveredMessage: "这个路径不在已发现的文档页面里，可能不是该文档站的 HTML 页面。",
    generatingMessage: "文档还在后台生成中，稍后刷新即可。",
    docHome: "返回文档站首页",
    translatePage: "翻译此页面"
  },
  en: {
    missingTitle: "Docs not found",
    missingMessage: "This documentation project does not exist yet.",
    plazaHome: "Back to Docs Plaza",
    oneDocHome: "Back to 1Doc home",
    failedTitle: "Page generation failed",
    undiscoveredTitle: "Page not discovered",
    generatingTitle: "Page is being generated",
    failedMessage: "This page failed to generate. You can retry failed pages from the project detail page.",
    undiscoveredMessage: "This path was not discovered as an HTML documentation page.",
    generatingMessage: "The documentation is still being generated in the background. Refresh again later.",
    docHome: "Back to docs home",
    translatePage: "Translate this page"
  },
  ja: {
    missingTitle: "ドキュメントがありません",
    missingMessage: "このドキュメントプロジェクトはまだ存在しません。",
    plazaHome: "ドキュメント広場へ戻る",
    oneDocHome: "1Doc ホームへ戻る",
    failedTitle: "ページ生成に失敗しました",
    undiscoveredTitle: "ページが未発見です",
    generatingTitle: "ページを生成中です",
    failedMessage: "このページの生成に失敗しました。詳細ページから失敗ページを再試行できます。",
    undiscoveredMessage: "このパスは HTML ドキュメントページとして検出されていません。",
    generatingMessage: "ドキュメントはバックグラウンドで生成中です。しばらくして更新してください。",
    docHome: "ドキュメントホームへ戻る",
    translatePage: "このページを翻訳"
  },
  ko: {
    missingTitle: "문서를 찾을 수 없습니다",
    missingMessage: "이 문서 프로젝트가 아직 없습니다.",
    plazaHome: "문서 광장으로 돌아가기",
    oneDocHome: "1Doc 홈으로 돌아가기",
    failedTitle: "페이지 생성 실패",
    undiscoveredTitle: "페이지를 발견하지 못함",
    generatingTitle: "페이지 생성 중",
    failedMessage: "이 페이지 생성에 실패했습니다. 상세 페이지에서 실패한 페이지를 재시도할 수 있습니다.",
    undiscoveredMessage: "이 경로는 HTML 문서 페이지로 발견되지 않았습니다.",
    generatingMessage: "문서가 백그라운드에서 생성 중입니다. 잠시 후 새로고침하세요.",
    docHome: "문서 홈으로 돌아가기",
    translatePage: "이 페이지 번역"
  },
  fr: {
    missingTitle: "Documentation introuvable",
    missingMessage: "Ce projet de documentation n'existe pas encore.",
    plazaHome: "Retour aux docs",
    oneDocHome: "Retour à l'accueil 1Doc",
    failedTitle: "Échec de génération",
    undiscoveredTitle: "Page non découverte",
    generatingTitle: "Page en génération",
    failedMessage: "Cette page n'a pas pu être générée. Relancez les pages en échec depuis le détail du projet.",
    undiscoveredMessage: "Ce chemin n'a pas été découvert comme page HTML de documentation.",
    generatingMessage: "La documentation est encore générée en arrière-plan. Actualisez plus tard.",
    docHome: "Retour à l'accueil",
    translatePage: "Traduire cette page"
  },
  de: {
    missingTitle: "Dokumentation nicht gefunden",
    missingMessage: "Dieses Dokumentationsprojekt existiert noch nicht.",
    plazaHome: "Zurück zu den Docs",
    oneDocHome: "Zurück zur 1Doc-Startseite",
    failedTitle: "Seitenerstellung fehlgeschlagen",
    undiscoveredTitle: "Seite nicht entdeckt",
    generatingTitle: "Seite wird erstellt",
    failedMessage: "Diese Seite konnte nicht erstellt werden. Fehlgeschlagene Seiten können in den Projektdetails erneut versucht werden.",
    undiscoveredMessage: "Dieser Pfad wurde nicht als HTML-Dokumentationsseite erkannt.",
    generatingMessage: "Die Dokumentation wird noch im Hintergrund erstellt. Bitte später aktualisieren.",
    docHome: "Zur Dokumentationsstartseite",
    translatePage: "Diese Seite übersetzen"
  },
  es: {
    missingTitle: "Documentación no encontrada",
    missingMessage: "Este proyecto de documentación aún no existe.",
    plazaHome: "Volver a Docs",
    oneDocHome: "Volver al inicio de 1Doc",
    failedTitle: "Falló la generación",
    undiscoveredTitle: "Página no descubierta",
    generatingTitle: "Página en generación",
    failedMessage: "Esta página no pudo generarse. Puedes reintentar las páginas fallidas desde el detalle del proyecto.",
    undiscoveredMessage: "Esta ruta no fue descubierta como una página HTML de documentación.",
    generatingMessage: "La documentación sigue generándose en segundo plano. Actualiza más tarde.",
    docHome: "Volver al inicio",
    translatePage: "Traducir esta página"
  },
  pt: {
    missingTitle: "Documentação não encontrada",
    missingMessage: "Este projeto de documentação ainda não existe.",
    plazaHome: "Voltar aos docs",
    oneDocHome: "Voltar ao início do 1Doc",
    failedTitle: "Falha ao gerar página",
    undiscoveredTitle: "Página não descoberta",
    generatingTitle: "Página em geração",
    failedMessage: "Esta página falhou ao gerar. Você pode tentar novamente nas páginas com falha do detalhe do projeto.",
    undiscoveredMessage: "Este caminho não foi descoberto como uma página HTML de documentação.",
    generatingMessage: "A documentação ainda está sendo gerada em segundo plano. Atualize mais tarde.",
    docHome: "Voltar ao início",
    translatePage: "Traduzir esta página"
  }
} as const;

type StatusLocale = keyof typeof statusMessages;

function statusLocale(value: string): StatusLocale {
  const normalized = value.toLowerCase().split("-")[0];
  return normalized in statusMessages ? (normalized as StatusLocale) : "en";
}

function statusHtml(
  title: string,
  message: string,
  actions: Array<{ href: string; label: string; primary?: boolean }> = [],
  form?: { action: string; label: string; url: string; path: string },
  locale: StatusLocale = "en"
): string {
  const actionHtml =
    actions.length > 0 || form
      ? `<div class="actions">${actions
          .map(
            (action) =>
              `<a class="${action.primary ? "primary" : ""}" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`
          )
          .join("")}${
          form
            ? `<form method="post" action="${escapeHtml(form.action)}"><input type="hidden" name="url" value="${escapeHtml(form.url)}"><input type="hidden" name="path" value="${escapeHtml(form.path)}"><button type="submit">${escapeHtml(form.label)}</button></form>`
            : ""
        }</div>`
      : "";

  return `<!doctype html>
<html lang="${locale === "zh" ? "zh-CN" : locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - 1Doc</title>
  <style>
    body{margin:0;background:#000;color:#fff;font-family:"Inter Variable",Inter,"Avenir Next","PingFang SC",system-ui,sans-serif;font-feature-settings:"cv01","cv05","cv09","cv11","ss03","ss07"}
    main{min-height:100vh;display:grid;place-items:center;padding:24px}
    section{max-width:720px;border-radius:15px;background:#090909;padding:30px;box-shadow:rgba(0,153,255,.15) 0 0 0 1px,rgba(255,255,255,.1) 0 .5px 0 .5px,rgba(0,0,0,.25) 0 10px 30px}
    h1{margin:0;font-family:"GT Walsheim Framer Medium","Avenir Next",system-ui,sans-serif;font-size:2rem;font-weight:500;line-height:1.05;letter-spacing:0}
    p{color:#a6a6a6;line-height:1.65}
    .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}
    form{margin:0}
    a,button{display:inline-flex;align-items:center;justify-content:center;min-height:40px;border:1px solid rgba(255,255,255,.12);border-radius:999px;background:rgba(255,255,255,.1);color:#fff;font:inherit;font-weight:500;text-decoration:none;padding:0 14px;cursor:pointer}
    a.primary,button{border-color:#fff;background:#fff;color:#000}
  </style>
</head>
<body>
  <main>
    <section>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      ${actionHtml}
    </section>
  </main>
</body>
</html>`;
}

function sourceUrlForPath(rootUrl: string, path: string): string {
  try {
    return new URL(path, rootUrl).toString();
  } catch {
    return rootUrl;
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ siteSlug: string; lang: string; path?: string[] }> }
) {
  const { siteSlug, lang, path = [] } = await context.params;
  const locale = statusLocale(lang);
  const copy = statusMessages[locale];
  const site = await getDocSiteBySlug(siteSlug);

  if (!site) {
    return new Response(statusHtml(copy.missingTitle, copy.missingMessage, [{ href: "/", label: copy.oneDocHome }], undefined, locale), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }

  const requestedPath = normalizeMirrorPath(`/${path.join("/")}`);
  const page = await getMirroredPage(site.id, lang, requestedPath);

  if (!page) {
    if (mirrorPathCandidates(requestedPath).includes(site.entry_path)) {
      const fallbackPage = (await listMirroredPages(site.id)).find((candidate) => candidate.lang === lang);
      if (fallbackPage) {
        return Response.redirect(new URL(`/sites/${site.slug}/${lang}${fallbackPage.path}`, _request.url), 302);
      }
    }

    const sourcePage = await getSourcePage(site.id, requestedPath);
    const status =
      sourcePage?.status === "failed"
        ? copy.failedTitle
        : site.status === "ready" && !sourcePage
          ? copy.undiscoveredTitle
          : copy.generatingTitle;
    const message =
      sourcePage?.status === "failed"
        ? sourcePage.last_error || copy.failedMessage
        : site.status === "ready" && !sourcePage
          ? copy.undiscoveredMessage
          : copy.generatingMessage;
    const homeHref = `/sites/${encodeURIComponent(site.slug)}/${encodeURIComponent(lang)}${site.entry_path}`;
    const translateUrl = sourcePage?.url ?? sourceUrlForPath(site.root_url, requestedPath);
    return new Response(
      statusHtml(
        status,
        message,
        [
          { href: "/", label: copy.oneDocHome },
          { href: homeHref, label: copy.docHome }
        ],
        {
          action: `/api/sites/${encodeURIComponent(site.slug)}/pages`,
          label: copy.translatePage,
          url: translateUrl,
          path: requestedPath
        },
        locale
      ),
      {
      status: sourcePage?.status === "failed" ? 500 : site.status === "ready" && !sourcePage ? 404 : 202,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
      }
    );
  }

  return new Response(page.html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800",
      "x-doc-native-site": site.slug,
      "x-doc-native-lang": lang,
      "x-doc-native-source-hash": page.source_html_hash
    }
  });
}
