import { localFaviconUrl } from "@/lib/favicon";
import {
  listCardMirroredPagesForSites,
  listDocSitesPage,
  listSiteVoteStats,
  searchDocSites
} from "@/lib/mirror/store";
import { decodeCursor, encodeCursor, normalizeLimit } from "@/lib/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_SEARCH_LIMIT = 12;
const MAX_SEARCH_LIMIT = 24;

async function siteResults(sites: Awaited<ReturnType<typeof searchDocSites>>) {
  const siteIds = sites.map((site) => site.id);
  const [mirroredPagesBySite, voteStats] = await Promise.all([
    listCardMirroredPagesForSites(sites),
    listSiteVoteStats(siteIds)
  ]);

  return sites
    .map((site) => {
      const mirroredPages = mirroredPagesBySite.get(site.id) ?? [];
      const mirrorUrls = site.target_langs
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
        .filter((url): url is { lang: string; url: string } => Boolean(url));

      return {
        id: site.id,
        slug: site.slug,
        entry_url: site.entry_url,
        target_langs: site.target_langs,
        status: site.status,
        discovered_count: site.discovered_count,
        generated_count: site.generated_count,
        failed_count: site.failed_count,
        faviconUrl: localFaviconUrl(site.entry_url),
        mirrorUrls,
        ...(voteStats.get(site.id) ?? { upvote_count: 0, downvote_count: 0, vote_score: 0, user_vote: 0 })
      };
    });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const keyword = searchParams.get("q") ?? "";
  const limit = normalizeLimit(searchParams.get("limit"), DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

  if (!keyword.trim()) {
    const cursor = decodeCursor<{ updated_at: string; id: string }>(searchParams.get("cursor"), ["updated_at", "id"]);
    const page = await listDocSitesPage({ limit, cursor });
    return Response.json({
      sites: await siteResults(page.sites),
      nextCursor: encodeCursor(page.nextCursor)
    });
  }

  const sites = await searchDocSites(keyword, limit * 2);
  const results = (await siteResults(sites)).slice(0, limit);

  return Response.json({ sites: results, nextCursor: null });
}
