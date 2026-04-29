import { textHash } from "./hash";
import { getTranslationCacheMany, setTranslationCacheMany } from "./cache";
import { translateWithArk } from "./ark";
import { translateWithVolc } from "./volc";

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.floor(value)));
}

function maxBatchItems(): number {
  return envInt("TRANSLATE_BATCH_ITEMS", 12, 1, 32);
}

function maxBatchChars(): number {
  return envInt("TRANSLATE_BATCH_CHARS", 3000, 300, 8000);
}

function batchConcurrency(): number {
  return envInt("TRANSLATE_BATCH_CONCURRENCY", 2, 1, 8);
}

function splitBatches(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  const itemLimit = maxBatchItems();
  const charLimit = maxBatchChars();

  for (const text of texts) {
    const textLength = text.length;
    if (current.length > 0 && (current.length >= itemLimit || chars + textLength > charLimit)) {
      batches.push(current);
      current = [];
      chars = 0;
    }

    if (textLength > charLimit) {
      for (let start = 0; start < text.length; start += charLimit) {
        batches.push([text.slice(start, start + charLimit)]);
      }
      continue;
    }

    current.push(text);
    chars += textLength;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

async function translateBatch(batch: string[], targetLang: string): Promise<string[]> {
  return process.env.ARK_API_KEY
    ? translateWithArk(batch, targetLang)
    : translateWithVolc({ textList: batch, targetLanguage: targetLang });
}

async function translateBatchWithFallback(batch: string[], targetLang: string): Promise<string[]> {
  try {
    return await translateBatch(batch, targetLang);
  } catch (error) {
    if (batch.length <= 1) {
      console.error("Translation item failed; falling back to source text", error);
      return batch;
    }

    const midpoint = Math.ceil(batch.length / 2);
    const [left, right] = await Promise.all([
      translateBatchWithFallback(batch.slice(0, midpoint), targetLang),
      translateBatchWithFallback(batch.slice(midpoint), targetLang)
    ]);
    return [...left, ...right];
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  handler: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await handler(items[index], index);
      }
    })
  );

  return results;
}

export async function translateTexts(texts: string[], targetLang: string): Promise<Map<string, string>> {
  const uniqueTexts = [...new Set(texts)];
  const translated = new Map<string, string>();
  const misses: Array<{ hash: string; text: string }> = [];
  const cacheableTexts = uniqueTexts.filter((text) => text.length <= maxBatchChars());

  for (const text of uniqueTexts) {
    if (text.length > maxBatchChars()) {
      translated.set(text, text);
    }
  }

  const hashedTexts = cacheableTexts.map((text) => ({ hash: textHash(text), text }));
  const cachedByHash = await getTranslationCacheMany(
    hashedTexts.map((item) => item.hash),
    targetLang
  );

  for (const item of hashedTexts) {
    const cached = cachedByHash.get(item.hash);
    if (cached) {
      translated.set(item.text, cached.translated_text);
    } else {
      misses.push(item);
    }
  }

  if (misses.length === 0) {
    return translated;
  }

  if (
    !process.env.ARK_API_KEY &&
    (!process.env.VOLC_ACCESS_KEY_ID || !process.env.VOLC_SECRET_ACCESS_KEY)
  ) {
    for (const miss of misses) {
      translated.set(miss.text, miss.text);
    }
    return translated;
  }

  const missByText = new Map(misses.map((miss) => [miss.text, miss]));
  const batches = splitBatches(misses.map((miss) => miss.text));
  const batchResults = await mapConcurrent(batches, batchConcurrency(), (batch) => translateBatchWithFallback(batch, targetLang));

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const result = batchResults[batchIndex];
    const cacheEntries: Array<{
      sourceTextHash: string;
      sourceText: string;
      targetLang: string;
      translatedText: string;
    }> = [];

    for (let index = 0; index < batch.length; index += 1) {
      const sourceText = batch[index];
      const translatedText = result[index] ?? sourceText;
      translated.set(sourceText, translatedText);
      cacheEntries.push({
        sourceTextHash: missByText.get(sourceText)?.hash ?? textHash(sourceText),
        sourceText,
        targetLang,
        translatedText
      });
    }

    await setTranslationCacheMany(cacheEntries);
  }

  return translated;
}
