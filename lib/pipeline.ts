import { fetchPage } from "./fetch-page";
import { getPageCache, getRenderCache, setPageCache, setRenderCache } from "./cache";
import { sha256 } from "./hash";
import { prepareHtmlForProxy, translateSnapshotHtml } from "./html";
import { normalizeUserUrl } from "./url";

export type TranslatePageResult = {
  html: string;
  sourceUrl: string;
  finalUrl: string;
  htmlHash: string;
  cache: {
    page: "hit" | "miss";
    render: "hit" | "miss";
  };
};

export async function translatePage(rawUrl: string, targetLang: string): Promise<TranslatePageResult> {
  const url = normalizeUserUrl(rawUrl).toString();
  const cachedPage = await getPageCache(url);
  const page =
    cachedPage ??
    (await (async () => {
      const fetched = await fetchPage(url);
      const htmlHash = sha256(fetched.html);
      return setPageCache(url, fetched.finalUrl, htmlHash, fetched.html);
    })());

  const cachedRender = await getRenderCache(url, targetLang, page.html_hash);
  if (cachedRender) {
    return {
      html: cachedRender.html,
      sourceUrl: url,
      finalUrl: page.final_url,
      htmlHash: page.html_hash,
      cache: {
        page: cachedPage ? "hit" : "miss",
        render: "hit"
      }
    };
  }

  const translatedHtml = prepareHtmlForProxy(page.html, page.final_url, targetLang);
  await setRenderCache(url, targetLang, page.html_hash, translatedHtml);

  return {
    html: translatedHtml,
    sourceUrl: url,
    finalUrl: page.final_url,
    htmlHash: page.html_hash,
    cache: {
      page: cachedPage ? "hit" : "miss",
      render: "miss"
    }
  };
}

export async function translateSnapshotPage(rawUrl: string, targetLang: string): Promise<TranslatePageResult> {
  const url = normalizeUserUrl(rawUrl).toString();
  const cachedPage = await getPageCache(url);
  const page =
    cachedPage ??
    (await (async () => {
      const fetched = await fetchPage(url);
      const htmlHash = sha256(fetched.html);
      return setPageCache(url, fetched.finalUrl, htmlHash, fetched.html);
    })());

  const cacheLang = `snapshot:${targetLang}`;
  const cachedRender = await getRenderCache(url, cacheLang, page.html_hash);
  if (cachedRender) {
    return {
      html: cachedRender.html,
      sourceUrl: url,
      finalUrl: page.final_url,
      htmlHash: page.html_hash,
      cache: {
        page: cachedPage ? "hit" : "miss",
        render: "hit"
      }
    };
  }

  const translatedHtml = await translateSnapshotHtml(page.html, page.final_url, targetLang);
  await setRenderCache(url, cacheLang, page.html_hash, translatedHtml);

  return {
    html: translatedHtml,
    sourceUrl: url,
    finalUrl: page.final_url,
    htmlHash: page.html_hash,
    cache: {
      page: cachedPage ? "hit" : "miss",
      render: "miss"
    }
  };
}
