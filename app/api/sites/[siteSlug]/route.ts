import { inngest } from "@/inngest/client";
import { localFaviconUrl } from "@/lib/favicon";
import { recoverStaleMirrorGeneration } from "@/lib/mirror/jobs";
import { getSiteProgress } from "@/lib/mirror/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ siteSlug: string }> }
) {
  const { siteSlug } = await context.params;
  const initialProgress = await getSiteProgress(siteSlug);
  if (!initialProgress) {
    return Response.json({ error: "Site not found." }, { status: 404 });
  }

  const recoveryMode = await recoverStaleMirrorGeneration(initialProgress.site.id, inngest, {
    trigger: "refresh",
    mode: "incremental"
  });
  const progress = recoveryMode === "skipped" ? initialProgress : await getSiteProgress(siteSlug);

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
