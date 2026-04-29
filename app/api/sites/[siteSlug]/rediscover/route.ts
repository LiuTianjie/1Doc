import { inngest } from "@/inngest/client";
import { enqueueMirrorGeneration, isMirrorGenerationActive } from "@/lib/mirror/jobs";
import { getDocSiteBySlug, updateDocSite } from "@/lib/mirror/store";

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

  if (await isMirrorGenerationActive(site.id, site)) {
    return Response.json({ error: "Generation is already running." }, { status: 409 });
  }

  await updateDocSite(site.id, { status: "queued", last_error: null });
  const generationMode = await enqueueMirrorGeneration(site.id, inngest, {
    force: true,
    trigger: "refresh",
    mode: "incremental"
  });

  return Response.json({ siteSlug, generationMode });
}
