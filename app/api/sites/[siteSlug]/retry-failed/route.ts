import { inngest } from "@/inngest/client";
import { enqueueMirrorGeneration } from "@/lib/mirror/jobs";
import { getDocSiteBySlug, listSourcePages, updateDocSite } from "@/lib/mirror/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ siteSlug: string }> }
) {
  const { siteSlug } = await context.params;
  const site = await getDocSiteBySlug(siteSlug);

  if (!site) {
    return Response.json({ error: "Site not found." }, { status: 404 });
  }

  const failedPages = (await listSourcePages(site.id)).filter((page) => page.status === "failed");
  if (failedPages.length === 0) {
    return Response.json({ siteSlug, generationMode: "skipped", failedCount: 0 });
  }

  await updateDocSite(site.id, { status: "queued", last_error: null });
  const generationMode = await enqueueMirrorGeneration(site.id, inngest, {
    trigger: "retry",
    mode: "retry_failed"
  });

  return Response.json({ siteSlug, generationMode, failedCount: failedPages.length });
}
