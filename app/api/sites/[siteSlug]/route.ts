import { inngest } from "@/inngest/client";
import { localFaviconUrl } from "@/lib/favicon";
import { recoverStaleMirrorGeneration } from "@/lib/mirror/jobs";
import {
  getDocSiteBySlug,
  getSiteProgress,
  listCardMirroredPagesForSites,
  listJobEvents,
  listSiteLlmTexts
} from "@/lib/mirror/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ siteSlug: string }> }
) {
  const { siteSlug } = await context.params;
  const includePages = new URL(request.url).searchParams.get("includePages") === "1";
  const initialSite = await getDocSiteBySlug(siteSlug);
  if (!initialSite) {
    return Response.json({ error: "Site not found." }, { status: 404 });
  }

  await recoverStaleMirrorGeneration(initialSite.id, inngest, {
    trigger: "refresh",
    mode: "incremental"
  });

  if (includePages) {
    const progress = await getSiteProgress(siteSlug);

    if (!progress) {
      return Response.json({ error: "Site not found." }, { status: 404 });
    }

    return Response.json({
      ...progress,
      site: {
        ...progress.site,
        faviconUrl: localFaviconUrl(progress.site.entry_url)
      },
      mirrorUrls: progress.site.target_langs
        .map((lang) => {
          const mirroredPage =
            progress.mirroredPages.find((page) => page.lang === lang && page.path === progress.site.entry_path) ??
            progress.mirroredPages.find((page) => page.lang === lang);

          return mirroredPage
            ? {
                lang,
                url: `/sites/${progress.site.slug}/${lang}${mirroredPage.path}`
              }
            : null;
        })
        .filter((url): url is { lang: string; url: string } => Boolean(url))
    });
  }

  const site = (await getDocSiteBySlug(siteSlug)) ?? initialSite;
  const [mirroredPagesBySite, llmTexts, events] = await Promise.all([
    listCardMirroredPagesForSites([site]),
    listSiteLlmTexts(site.id),
    listJobEvents(site.id)
  ]);
  const mirroredPages = mirroredPagesBySite.get(site.id) ?? [];

  return Response.json({
    site: {
      ...site,
      faviconUrl: localFaviconUrl(site.entry_url)
    },
    llmTexts: llmTexts.map(({ lang, page_count, generated_at, updated_at }) => ({
      lang,
      page_count,
      generated_at,
      updated_at
    })),
    events,
    mirrorUrls: site.target_langs
      .map((lang) => {
        const mirroredPage =
          mirroredPages.find((page) => page.lang === lang && page.path === site.entry_path) ??
          mirroredPages.find((page) => page.lang === lang);

        return mirroredPage
          ? {
              lang,
              url: `/sites/${site.slug}/${lang}${mirroredPage.path}`
            }
          : null;
      })
      .filter((url): url is { lang: string; url: string } => Boolean(url))
  });
}
