import { generateSiteLlmText, generateSiteLlmTexts } from "@/lib/mirror/llm-text";
import { getDocSiteBySlug, getSiteLlmText } from "@/lib/mirror/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function storageErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  if (message.includes("site_llm_texts")) {
    return "LLM.txt storage is not initialized. Run the latest supabase/schema.sql first.";
  }
  return message;
}

function normalizeLang(value: string | null, fallback: string): string {
  const lang = value?.trim().toLowerCase();
  return lang || fallback;
}

export async function GET(request: Request, context: { params: Promise<{ siteSlug: string }> }) {
  const { siteSlug } = await context.params;
  const site = await getDocSiteBySlug(siteSlug);

  if (!site) {
    return Response.json({ error: "Site not found." }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const lang = normalizeLang(searchParams.get("lang"), site.target_langs[0]);
  const llmText = await getSiteLlmText(site.id, lang);

  if (!llmText) {
    return Response.json({ error: `LLM.txt has not been generated for ${lang}.` }, { status: 404 });
  }

  if (searchParams.get("format") === "txt") {
    return new Response(llmText.content, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }

  return Response.json({ siteSlug: site.slug, ...llmText });
}

export async function POST(request: Request, context: { params: Promise<{ siteSlug: string }> }) {
  const { siteSlug } = await context.params;
  const site = await getDocSiteBySlug(siteSlug);

  if (!site) {
    return Response.json({ error: "Site not found." }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as { lang?: unknown };
  const lang = typeof body.lang === "string" ? body.lang.trim().toLowerCase() : "";

  try {
    const llmTexts = lang ? [await generateSiteLlmText(site.id, lang)] : await generateSiteLlmTexts(site.id);
    return Response.json({
      siteSlug: site.slug,
      llmTexts,
      llmText: llmTexts[0] ?? null
    });
  } catch (error) {
    return Response.json({ error: storageErrorMessage(error) }, { status: 400 });
  }
}
