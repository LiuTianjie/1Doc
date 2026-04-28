import { retryMirrorPage } from "@/lib/mirror/generator";
import { getDocSiteBySlug } from "@/lib/mirror/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ siteSlug: string; pageId: string }> }
) {
  const { siteSlug, pageId } = await context.params;
  const site = await getDocSiteBySlug(siteSlug);

  if (!site) {
    return Response.json({ error: "Site not found." }, { status: 404 });
  }

  try {
    await retryMirrorPage(site.id, pageId);
    return Response.json({ siteSlug, pageId, status: "ok" });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to retry page." },
      { status: 400 }
    );
  }
}
