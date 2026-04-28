import { translateTexts } from "@/lib/translate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const configuredToken = process.env.TRANSLATE_API_TOKEN;
  const authHeader = request.headers.get("authorization") ?? "";

  if (configuredToken && authHeader !== `Bearer ${configuredToken}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await request.json()) as { texts?: unknown; targetLang?: unknown };
  if (!Array.isArray(body.texts) || typeof body.targetLang !== "string") {
    return Response.json({ error: "Expected { texts: string[], targetLang: string }." }, { status: 400 });
  }

  const texts = body.texts
    .filter((value): value is string => typeof value === "string")
    .slice(0, 32);
  const totalChars = texts.reduce((sum, text) => sum + text.length, 0);

  if (totalChars > 4000) {
    return Response.json({ error: "Batch is too large." }, { status: 413 });
  }

  try {
    const translations = await translateTexts(texts, body.targetLang);

    return Response.json({
      translations: texts.map((text) => translations.get(text) ?? text)
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Translation failed.",
        translations: texts
      },
      { status: 200 }
    );
  }
}
