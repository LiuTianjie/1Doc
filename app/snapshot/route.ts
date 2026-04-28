import { translateSnapshotPage } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const errorMessages = {
  zh: {
    title: "快照失败",
    heading: "翻译快照生成失败",
    missingUrl: "缺少文档站链接。",
    unknown: "未知错误。",
    home: "返回首页"
  },
  en: {
    title: "Snapshot failed",
    heading: "Translated snapshot failed",
    missingUrl: "Missing documentation URL.",
    unknown: "Unknown error.",
    home: "Back home"
  }
};

type ErrorLocale = keyof typeof errorMessages;

function errorLocale(lang: string): ErrorLocale {
  return lang.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function errorHtml(message: string, lang = "zh"): string {
  const locale = errorLocale(lang);
  const text = errorMessages[locale];
  return `<!doctype html>
<html lang="${locale === "zh" ? "zh-CN" : "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${text.title} - 1Doc</title>
  <style>
    body{margin:0;background:#f6f7f4;color:#17201d;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{min-height:100vh;display:grid;place-items:center;padding:24px}
    section{max-width:640px;border:1px solid #d8ded7;border-radius:8px;background:#fff;padding:28px;box-shadow:0 20px 50px rgba(23,32,29,.1)}
    h1{margin:0;font-size:1.8rem;line-height:1.15}
    p{color:#64706b;line-height:1.65}
    a{color:#115e59;font-weight:800}
  </style>
</head>
<body>
  <main>
    <section>
      <h1>${text.heading}</h1>
      <p>${escapeHtml(message)}</p>
      <a href="/">${text.home}</a>
    </section>
  </main>
</body>
</html>`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get("url");
  const lang = searchParams.get("lang") || "zh";

  if (!targetUrl) {
    return new Response(errorHtml(errorMessages[errorLocale(lang)].missingUrl, lang), {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }

  try {
    const result = await translateSnapshotPage(targetUrl, lang);
    return new Response(result.html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-doc-native-mode": "snapshot",
        "x-doc-native-page-cache": result.cache.page,
        "x-doc-native-render-cache": result.cache.render,
        "x-doc-native-html-hash": result.htmlHash
      }
    });
  } catch (error) {
    return new Response(errorHtml(error instanceof Error ? error.message : errorMessages[errorLocale(lang)].unknown, lang), {
      status: 502,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
}
