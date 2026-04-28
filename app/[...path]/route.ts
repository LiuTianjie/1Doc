import { findMirrorTargetByPath } from "@/lib/mirror/store";
import { normalizeMirrorPath } from "@/lib/mirror/url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ path?: string[] }> }
) {
  const { path = [] } = await context.params;
  const requestedPath = normalizeMirrorPath(`/${path.join("/")}`);
  const target = await findMirrorTargetByPath(requestedPath);

  if (target) {
    return Response.redirect(new URL(`/sites/${target.site.slug}/${target.lang}${target.path}`, request.url), 302);
  }

  return new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
