import { getDocSiteBySlug, setSiteVote } from "@/lib/mirror/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeVote(value: unknown): -1 | 0 | 1 | null {
  if (value === -1 || value === 0 || value === 1) {
    return value;
  }
  return null;
}

function voteErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("PGRST205") || message.includes("site_votes")) {
    return "Vote storage is not initialized. Run the site_votes SQL from supabase/schema.sql in Supabase, then retry.";
  }
  return message || "Failed to update vote.";
}

export async function POST(
  request: Request,
  context: { params: Promise<{ siteSlug: string }> }
) {
  const { siteSlug } = await context.params;
  const body = (await request.json()) as { voterId?: unknown; value?: unknown };
  const voterId = typeof body.voterId === "string" ? body.voterId.trim() : "";
  const value = normalizeVote(body.value);

  if (!voterId || voterId.length > 128 || value === null) {
    return Response.json({ error: "Expected { voterId: string, value: -1 | 0 | 1 }." }, { status: 400 });
  }

  const site = await getDocSiteBySlug(siteSlug);
  if (!site) {
    return Response.json({ error: "Site not found." }, { status: 404 });
  }

  try {
    const stats = await setSiteVote(site.id, voterId, value);
    return Response.json({ siteSlug, ...stats });
  } catch (error) {
    return Response.json(
      {
        error: voteErrorMessage(error)
      },
      { status: 400 }
    );
  }
}
