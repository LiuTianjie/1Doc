import { retryMirrorPage } from "@/lib/mirror/generator";
import {
  getDocSiteBySlug,
  getSourcePage,
  listSiteSourcePageItems,
  type SourcePageFilter,
  upsertSourcePage
} from "@/lib/mirror/store";
import { canonicalPageUrl, isMirrorablePage, mirrorPathFor, normalizeMirrorPath } from "@/lib/mirror/url";
import { decodeCursor, encodeCursor, normalizeLimit } from "@/lib/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const DEFAULT_PAGE_LIMIT = 30;
const MAX_PAGE_LIMIT = 48;

function redirectToDetail(request: Request, siteSlug: string): Response {
  return Response.redirect(new URL(`/sites/${siteSlug}`, request.url), 303);
}

function jsonOrRedirect(request: Request, siteSlug: string, payload: Record<string, unknown>, status = 200): Response {
  const accept = request.headers.get("accept") ?? "";
  const contentType = request.headers.get("content-type") ?? "";
  if (!accept.includes("application/json") && !contentType.includes("application/json")) {
    return redirectToDetail(request, siteSlug);
  }

  return Response.json(payload, { status });
}

function normalizeFilter(value: string | null): SourcePageFilter {
  return value === "active" || value === "failed" || value === "ready" ? value : "all";
}

export async function GET(
  request: Request,
  context: { params: Promise<{ siteSlug: string }> }
) {
  const { siteSlug } = await context.params;
  const site = await getDocSiteBySlug(siteSlug);

  if (!site) {
    return Response.json({ error: "Site not found." }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const filter = normalizeFilter(searchParams.get("filter"));
  const limit = normalizeLimit(searchParams.get("limit"), DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
  const cursor = decodeCursor<{ path: string; id: string }>(searchParams.get("cursor"), ["path", "id"]);
  const page = await listSiteSourcePageItems({ site, filter, limit, cursor });

  return Response.json({
    pages: page.pages,
    counts: page.counts,
    nextCursor: encodeCursor(page.nextCursor)
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ siteSlug: string }> }
) {
  const { siteSlug } = await context.params;
  const site = await getDocSiteBySlug(siteSlug);

  if (!site) {
    return Response.json({ error: "Site not found." }, { status: 404 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? ((await request.json()) as { url?: unknown; path?: unknown })
    : Object.fromEntries((await request.formData()).entries());

  const rawUrl = typeof payload.url === "string" ? payload.url : "";
  const rawPath = typeof payload.path === "string" ? payload.path : "";

  try {
    const url = rawUrl ? canonicalPageUrl(rawUrl) : canonicalPageUrl(new URL(rawPath || site.entry_path, site.root_url).toString());
    const path = rawPath ? normalizeMirrorPath(rawPath) : mirrorPathFor(url);

    if (!isMirrorablePage(url, site.root_url, site.scope_path)) {
      return jsonOrRedirect(request, site.slug, { error: "Page is outside this mirror scope." }, 400);
    }

    const existing = await getSourcePage(site.id, path);
    const page =
      existing ??
      (await upsertSourcePage({
        site_id: site.id,
        url,
        path,
        title: null,
        html_hash: null,
        status: "queued",
        last_error: null
      }));

    void retryMirrorPage(site.id, page.id).catch((error) => {
      console.error("Single page translation failed", error);
    });

    return jsonOrRedirect(request, site.slug, {
      siteSlug: site.slug,
      pageId: page.id,
      path: page.path,
      queued: true,
      detailUrl: `/sites/${site.slug}`
    });
  } catch (error) {
    return jsonOrRedirect(
      request,
      site.slug,
      { error: error instanceof Error ? error.message : "Failed to queue page translation." },
      400
    );
  }
}
