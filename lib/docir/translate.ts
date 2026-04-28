import { translateTexts } from "../translate";
import type { ExtractedDocPage } from "./types";
import { restoreText } from "./protect";

export type DocTranslationStats = {
  blockCount: number;
  textSegmentCount: number;
  translatedSegmentCount: number;
  untranslatedSegmentCount: number;
  rootFound: boolean;
};

export async function translateExtractedDocPage(
  page: ExtractedDocPage,
  targetLang: string
): Promise<DocTranslationStats> {
  const sources = page.patches.map((patch) => patch.protectedSource);
  const translated = await translateTexts(sources, targetLang);
  let translatedSegmentCount = 0;

  for (const patch of page.patches) {
    const translatedText = translated.get(patch.protectedSource) ?? patch.protectedSource;
    const restored = restoreText(translatedText, patch.tokens);
    if (restored !== patch.source) {
      translatedSegmentCount += 1;
    }
    patch.node.value = `${patch.prefix}${restored}${patch.suffix}`;
  }

  return {
    blockCount: page.blocks.length,
    textSegmentCount: page.patches.length,
    translatedSegmentCount,
    untranslatedSegmentCount: page.patches.length - translatedSegmentCount,
    rootFound: page.rootFound
  };
}
