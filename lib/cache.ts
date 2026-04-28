import { sha256 } from "./hash";

export type PageCacheEntry = {
  key: string;
  url: string;
  final_url: string;
  html_hash: string;
  html: string;
  fetched_at: string;
  expires_at: string;
};

export type RenderCacheEntry = {
  key: string;
  url: string;
  target_lang: string;
  html_hash: string;
  html: string;
  created_at: string;
  expires_at: string;
};

export type TranslationCacheEntry = {
  key: string;
  source_text_hash: string;
  source_text: string;
  target_lang: string;
  translated_text: string;
  created_at: string;
};

type CacheTable = "page_cache" | "render_cache" | "translation_cache" | "translation_segments";

const memoryStore = new Map<string, unknown>();

function nowIso(): string {
  return new Date().toISOString();
}

function ttlIso(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function isExpired(entry: { expires_at?: string } | null | undefined): boolean {
  if (!entry?.expires_at) {
    return false;
  }

  return Date.parse(entry.expires_at) <= Date.now();
}

async function supabaseRequest<T>(
  table: CacheTable,
  init: RequestInit & { query?: string } = {}
): Promise<T | null> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return null;
  }

  const query = init.query ?? "";
  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/${table}${query}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {})
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Supabase ${table} request failed: ${response.status} ${await response.text()}`);
  }

  if (response.status === 204) {
    return null;
  }

  const body = await response.text();
  if (!body) {
    return null;
  }

  return JSON.parse(body) as T;
}

async function getByKey<T>(table: CacheTable, key: string): Promise<T | null> {
  const memoryKey = `${table}:${key}`;
  const inMemory = memoryStore.get(memoryKey) as T | undefined;
  if (inMemory) {
    return inMemory;
  }

  const rows = await supabaseRequest<T[]>(table, {
    method: "GET",
    query: `?key=eq.${encodeURIComponent(key)}&limit=1`
  });

  return rows?.[0] ?? null;
}

async function upsert<T extends { key: string }>(table: CacheTable, value: T): Promise<void> {
  memoryStore.set(`${table}:${value.key}`, value);

  await supabaseRequest(table, {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify(value)
  });
}

export function pageCacheKey(url: string): string {
  return sha256(`page:${url}`);
}

export function renderCacheKey(url: string, targetLang: string, htmlHash: string): string {
  return sha256(`render:v3:${url}:${targetLang}:${htmlHash}`);
}

export function translationCacheKey(sourceTextHash: string, targetLang: string): string {
  return sha256(`translation:${targetLang}:${sourceTextHash}`);
}

export async function getPageCache(url: string): Promise<PageCacheEntry | null> {
  const entry = await getByKey<PageCacheEntry>("page_cache", pageCacheKey(url));
  return isExpired(entry) ? null : entry;
}

export async function setPageCache(
  url: string,
  finalUrl: string,
  htmlHash: string,
  html: string,
  ttlSeconds = 60 * 60 * 24
): Promise<PageCacheEntry> {
  const entry: PageCacheEntry = {
    key: pageCacheKey(url),
    url,
    final_url: finalUrl,
    html_hash: htmlHash,
    html,
    fetched_at: nowIso(),
    expires_at: ttlIso(ttlSeconds)
  };
  await upsert("page_cache", entry);
  return entry;
}

export async function getRenderCache(
  url: string,
  targetLang: string,
  htmlHash: string
): Promise<RenderCacheEntry | null> {
  const entry = await getByKey<RenderCacheEntry>("render_cache", renderCacheKey(url, targetLang, htmlHash));
  return isExpired(entry) ? null : entry;
}

export async function setRenderCache(
  url: string,
  targetLang: string,
  htmlHash: string,
  html: string,
  ttlSeconds = 60 * 60 * 24
): Promise<RenderCacheEntry> {
  const entry: RenderCacheEntry = {
    key: renderCacheKey(url, targetLang, htmlHash),
    url,
    target_lang: targetLang,
    html_hash: htmlHash,
    html,
    created_at: nowIso(),
    expires_at: ttlIso(ttlSeconds)
  };
  await upsert("render_cache", entry);
  return entry;
}

export async function getTranslationCache(
  sourceTextHash: string,
  targetLang: string
): Promise<TranslationCacheEntry | null> {
  const key = translationCacheKey(sourceTextHash, targetLang);
  return (
    (await getByKey<TranslationCacheEntry>("translation_segments", key)) ??
    (await getByKey<TranslationCacheEntry>("translation_cache", key))
  );
}

export async function setTranslationCache(
  sourceTextHash: string,
  sourceText: string,
  targetLang: string,
  translatedText: string
): Promise<TranslationCacheEntry> {
  const entry: TranslationCacheEntry = {
    key: translationCacheKey(sourceTextHash, targetLang),
    source_text_hash: sourceTextHash,
    source_text: sourceText,
    target_lang: targetLang,
    translated_text: translatedText,
    created_at: nowIso()
  };
  await upsert("translation_segments", entry);
  return entry;
}
