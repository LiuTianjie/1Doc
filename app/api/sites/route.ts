import {
  createOrReuseDocSite,
  listDocSites,
  listLatestJobEventsForSites,
  listMirroredPages,
  listMirroredPagesForSites,
  listSiteLlmTextsForSites,
  listSiteVoteStats
} from "@/lib/mirror/store";
import { enqueueMirrorGeneration } from "@/lib/mirror/jobs";
import { inngest } from "@/inngest/client";
import { localFaviconUrl } from "@/lib/favicon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function voterKeyFromRequest(request: Request): string | undefined {
  const { searchParams } = new URL(request.url);
  const value = searchParams.get("voterId")?.trim();
  return value && value.length <= 128 ? value : undefined;
}

export async function GET(request: Request) {
  const sites = await listDocSites();
  const siteIds = sites.map((site) => site.id);
  const [voteStats, latestEvents, mirroredPagesBySite, llmTextsBySite] = await Promise.all([
    listSiteVoteStats(siteIds, voterKeyFromRequest(request)),
    listLatestJobEventsForSites(siteIds),
    listMirroredPagesForSites(siteIds),
    listSiteLlmTextsForSites(siteIds)
  ]);
  const siteCards = sites.map((site) => {
      const mirroredPages = mirroredPagesBySite.get(site.id) ?? [];
      const llmTexts = llmTextsBySite.get(site.id) ?? [];
      return {
        ...site,
        ...(voteStats.get(site.id) ?? { upvote_count: 0, downvote_count: 0, vote_score: 0, user_vote: 0 }),
        faviconUrl: localFaviconUrl(site.entry_url),
        latestEvent: latestEvents.get(site.id) ?? null,
        llmTexts: llmTexts.map(({ lang, page_count, generated_at, updated_at }) => ({
          lang,
          page_count,
          generated_at,
          updated_at
        })),
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
      };
    });
  const displayableSiteCards = siteCards.filter((site) => site.status !== "ready" || site.mirrorUrls.length > 0);

  displayableSiteCards.sort(
    (a, b) =>
      b.vote_score - a.vote_score ||
      b.upvote_count - a.upvote_count ||
      b.generated_count - a.generated_count ||
      b.updated_at.localeCompare(a.updated_at)
  );

  return Response.json({
    sites: displayableSiteCards
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    entryUrl?: unknown;
    targetLangs?: unknown;
    pageLimit?: unknown;
  };

  if (typeof body.entryUrl !== "string" || !Array.isArray(body.targetLangs)) {
    return Response.json({ error: "Expected { entryUrl: string, targetLangs: string[] }." }, { status: 400 });
  }

  const targetLangs = body.targetLangs.filter((value): value is string => typeof value === "string");
  const pageLimit = typeof body.pageLimit === "number" ? body.pageLimit : undefined;

  try {
    const { site, reused, shouldEnqueue } = await createOrReuseDocSite({
      entryUrl: body.entryUrl,
      targetLangs,
      pageLimit
    });
    const generationMode = shouldEnqueue ? await enqueueMirrorGeneration(site.id, inngest, { trigger: "create" }) : "skipped";
    const mirroredPages = await listMirroredPages(site.id);
    const preferredLang = targetLangs.find((lang) => site.target_langs.includes(lang)) ?? site.target_langs[0];
    const primaryMirror =
      mirroredPages.find((page) => page.lang === preferredLang && page.path === site.entry_path) ??
      mirroredPages.find((page) => page.lang === preferredLang) ??
      mirroredPages.find((page) => page.path === site.entry_path) ??
      mirroredPages[0];

    return Response.json({
      site,
      reused,
      generationMode,
      mirrorUrl: primaryMirror ? `/sites/${site.slug}/${primaryMirror.lang}${primaryMirror.path}` : null
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to create mirror site." },
      { status: 400 }
    );
  }
}
