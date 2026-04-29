import {
  mirrorPathCandidates,
  mirrorPathFor,
  normalizePageLimit,
  normalizeTargetLangs,
  rootUrlFor,
  scopePathFor,
  siteSlugFor
} from "./url";
import type {
  CreateSiteInput,
  DocSite,
  GenerationJob,
  JobEvent,
  MirroredPage,
  MirroredPageSummary,
  SiteLlmText,
  SiteVote,
  SiteVoteStats,
  SiteProgress,
  SiteStatus,
  SourcePage
} from "./types";

type MirrorTable =
  | "doc_sites"
  | "source_pages"
  | "mirrored_pages"
  | "generation_jobs"
  | "generation_locks"
  | "job_events"
  | "site_llm_text_locks"
  | "site_llm_texts"
  | "site_votes";

type MirrorMemory = {
  sites: Map<string, DocSite>;
  pages: Map<string, SourcePage>;
  mirrored: Map<string, MirroredPage>;
  jobs?: Map<string, GenerationJob>;
  locks?: Map<string, GenerationLock>;
  llmTextLocks?: Map<string, SiteLlmTextLock>;
  votes?: Map<string, SiteVote>;
  llmTexts?: Map<string, SiteLlmText>;
  events: Map<string, JobEvent>;
};

type GenerationLock = {
  site_id: string;
  job_id: string;
  created_at: string;
  expires_at: string;
};

type SiteLlmTextLock = {
  lock_key: string;
  site_id: string;
  lang: string;
  created_at: string;
  expires_at: string;
};

type SourcePageInput = Omit<SourcePage, "id" | "discovered_at" | "updated_at">;

const globalForMirror = globalThis as typeof globalThis & {
  __docNativeMirrorMemory?: MirrorMemory;
};

const memoryBase =
  globalForMirror.__docNativeMirrorMemory ??
  (globalForMirror.__docNativeMirrorMemory = {
    sites: new Map<string, DocSite>(),
    pages: new Map<string, SourcePage>(),
    mirrored: new Map<string, MirroredPage>(),
    jobs: new Map<string, GenerationJob>(),
    locks: new Map<string, GenerationLock>(),
    llmTextLocks: new Map<string, SiteLlmTextLock>(),
    votes: new Map<string, SiteVote>(),
    llmTexts: new Map<string, SiteLlmText>(),
    events: new Map<string, JobEvent>()
  });

memoryBase.jobs ??= new Map<string, GenerationJob>();
memoryBase.locks ??= new Map<string, GenerationLock>();
memoryBase.llmTextLocks ??= new Map<string, SiteLlmTextLock>();
memoryBase.votes ??= new Map<string, SiteVote>();
memoryBase.llmTexts ??= new Map<string, SiteLlmText>();

const memory = memoryBase as MirrorMemory & {
  jobs: Map<string, GenerationJob>;
  locks: Map<string, GenerationLock>;
  llmTextLocks: Map<string, SiteLlmTextLock>;
  votes: Map<string, SiteVote>;
  llmTexts: Map<string, SiteLlmText>;
};

class SupabaseRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
  }
}

const LOCK_TTL_MS = 6 * 60 * 60 * 1000;
const LLM_TEXT_LOCK_TTL_MS = 15 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function usesSupabase(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function supabaseRequest<T>(
  table: MirrorTable,
  init: RequestInit & { query?: string } = {}
): Promise<T | null> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return null;
  }

  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/${table}${init.query ?? ""}`, {
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
    const body = await response.text();
    throw new SupabaseRequestError(`Supabase ${table} request failed: ${response.status} ${body}`, response.status, body);
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

function siteMemoryKey(slug: string): string {
  return slug;
}

function sourcePageMemoryKey(siteId: string, path: string): string {
  return `${siteId}:${path}`;
}

function mirroredPageMemoryKey(siteId: string, lang: string, path: string): string {
  return `${siteId}:${lang}:${path}`;
}

function siteVoteMemoryKey(siteId: string, voterKey: string): string {
  return `${siteId}:${voterKey}`;
}

function siteLlmTextMemoryKey(siteId: string, lang: string): string {
  return `${siteId}:${lang}`;
}

function siteLlmTextLockKey(siteId: string, lang: string): string {
  return `${siteId}:${lang}`;
}

function isGenerationJobActive(job: GenerationJob): boolean {
  return job.status === "queued" || job.status === "running";
}

function lockExpiresAt(): string {
  return new Date(Date.now() + LOCK_TTL_MS).toISOString();
}

function llmTextLockExpiresAt(): string {
  return new Date(Date.now() + LLM_TEXT_LOCK_TTL_MS).toISOString();
}

function isExpired(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function normalizeGenerationJob(row: Partial<GenerationJob> & Pick<GenerationJob, "id" | "site_id">): GenerationJob {
  const now = nowIso();
  return {
    id: row.id,
    site_id: row.site_id,
    status: row.status ?? "queued",
    trigger: row.trigger ?? "system",
    pages_total: row.pages_total ?? 0,
    pages_done: row.pages_done ?? 0,
    pages_failed: row.pages_failed ?? 0,
    last_error: row.last_error ?? null,
    created_at: row.created_at ?? now,
    updated_at: row.updated_at ?? row.created_at ?? now,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null
  };
}

function legacyPageStatus(status: SourcePage["status"]): SourcePage["status"] {
  if (status === "translating" || status === "publishing" || status === "skipped") {
    return "ready";
  }

  return status;
}

function sourcePageForSupabase(page: SourcePage): SourcePage {
  return {
    ...page,
    status: legacyPageStatus(page.status)
  };
}

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function isSiteActive(site: DocSite): boolean {
  if (!["queued", "discovering", "generating"].includes(site.status)) {
    return false;
  }

  const updatedAt = Date.parse(site.updated_at);
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt < 5 * 60 * 1000;
}

function isSiteComplete(site: DocSite): boolean {
  if (site.status !== "ready" || site.discovered_count === 0) {
    return false;
  }

  return site.generated_count >= site.discovered_count * site.target_langs.length;
}

export async function createOrReuseDocSite(
  input: CreateSiteInput
): Promise<{ site: DocSite; reused: boolean; shouldEnqueue: boolean }> {
  const entryUrl = input.entryUrl;
  const targetLangs = normalizeTargetLangs(input.targetLangs);
  if (targetLangs.length === 0) {
    throw new Error("At least one target language is required.");
  }

  const slug = siteSlugFor(entryUrl);
  const existing = await getDocSiteBySlug(slug);
  if (existing) {
    const mergedLangs = [...new Set([...existing.target_langs, ...targetLangs])].slice(0, 8);
    const nextPageLimit = Math.max(existing.page_limit, normalizePageLimit(input.pageLimit));
    const patch: Partial<DocSite> = {};

    if (!sameStringArray(existing.target_langs, mergedLangs)) {
      patch.target_langs = mergedLangs;
    }

    if (nextPageLimit !== existing.page_limit) {
      patch.page_limit = nextPageLimit;
    }

    if (Object.keys(patch).length > 0) {
      await updateDocSite(existing.id, patch);
    }

    const site = (await getDocSiteBySlug(slug)) ?? { ...existing, ...patch };
    const needsNewLanguages = !sameStringArray(existing.target_langs, mergedLangs);
    const shouldEnqueue = !isSiteActive(site) && (!isSiteComplete(site) || needsNewLanguages);
    return { site, reused: true, shouldEnqueue };
  }

  const now = nowIso();
  const site: DocSite = {
    id: crypto.randomUUID(),
    slug,
    entry_url: entryUrl,
    root_url: rootUrlFor(entryUrl),
    scope_path: scopePathFor(entryUrl),
    entry_path: mirrorPathFor(entryUrl),
    title: null,
    target_langs: targetLangs,
    status: "queued",
    page_limit: normalizePageLimit(input.pageLimit),
    discovered_count: 0,
    generated_count: 0,
    failed_count: 0,
    last_error: null,
    created_at: now,
    updated_at: now
  };

  memory.sites.set(siteMemoryKey(site.slug), site);

  if (usesSupabase()) {
    const rows = await supabaseRequest<DocSite[]>("doc_sites", {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      query: "?on_conflict=slug",
      body: JSON.stringify(site)
    });
    return { site: rows?.[0] ?? site, reused: false, shouldEnqueue: true };
  }

  return { site, reused: false, shouldEnqueue: true };
}

export async function createDocSite(input: CreateSiteInput): Promise<DocSite> {
  return (await createOrReuseDocSite(input)).site;
}

export async function getDocSiteBySlug(slug: string): Promise<DocSite | null> {
  if (usesSupabase()) {
    const rows = await supabaseRequest<DocSite[]>("doc_sites", {
      method: "GET",
      query: `?slug=eq.${encodeURIComponent(slug)}&limit=1`
    });
    return rows?.[0] ?? null;
  }

  const inMemory = memory.sites.get(siteMemoryKey(slug));
  if (inMemory) {
    return inMemory;
  }

  return null;
}

export async function getDocSiteById(siteId: string): Promise<DocSite | null> {
  if (usesSupabase()) {
    const rows = await supabaseRequest<DocSite[]>("doc_sites", {
      method: "GET",
      query: `?id=eq.${encodeURIComponent(siteId)}&limit=1`
    });
    return rows?.[0] ?? null;
  }

  const inMemory = [...memory.sites.values()].find((site) => site.id === siteId);
  if (inMemory) {
    return inMemory;
  }

  return null;
}

export async function listDocSites(): Promise<DocSite[]> {
  if (usesSupabase()) {
    const rows = await supabaseRequest<DocSite[]>("doc_sites", {
      method: "GET",
      query: "?order=updated_at.desc&limit=100"
    });
    return rows ?? [];
  }

  return [...memory.sites.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function resetSiteContent(siteId: string): Promise<void> {
  for (const [key, page] of memory.pages.entries()) {
    if (page.site_id === siteId) {
      memory.pages.delete(key);
    }
  }

  for (const [key, page] of memory.mirrored.entries()) {
    if (page.site_id === siteId) {
      memory.mirrored.delete(key);
    }
  }

  for (const [key, item] of memory.llmTexts.entries()) {
    if (item.site_id === siteId) {
      memory.llmTexts.delete(key);
    }
  }

  await supabaseRequest("site_llm_texts", {
    method: "DELETE",
    query: `?site_id=eq.${encodeURIComponent(siteId)}`
  }).catch((error) => {
    console.warn("Could not clear site LLM texts.", error);
  });
  await supabaseRequest("mirrored_pages", {
    method: "DELETE",
    query: `?site_id=eq.${encodeURIComponent(siteId)}`
  });
  await supabaseRequest("source_pages", {
    method: "DELETE",
    query: `?site_id=eq.${encodeURIComponent(siteId)}`
  });
  await updateDocSite(siteId, {
    discovered_count: 0,
    generated_count: 0,
    failed_count: 0,
    last_error: null
  });
}

export async function updateDocSite(siteId: string, patch: Partial<DocSite>): Promise<void> {
  const current = await getDocSiteById(siteId);
  if (!current) {
    return;
  }

  const next = { ...current, ...patch, updated_at: nowIso() };
  memory.sites.set(siteMemoryKey(next.slug), next);

  await supabaseRequest("doc_sites", {
    method: "PATCH",
    query: `?id=eq.${encodeURIComponent(siteId)}`,
    body: JSON.stringify({ ...patch, updated_at: next.updated_at })
  });
}

export async function addJobEvent(
  siteId: string,
  level: JobEvent["level"],
  message: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const event: JobEvent = {
    id: crypto.randomUUID(),
    site_id: siteId,
    level,
    message,
    metadata,
    created_at: nowIso()
  };
  memory.events.set(event.id, event);

  await supabaseRequest("job_events", {
    method: "POST",
    body: JSON.stringify(event)
  });
}

export async function listGenerationJobs(siteId: string): Promise<GenerationJob[]> {
  if (usesSupabase()) {
    const rows = await supabaseRequest<GenerationJob[]>("generation_jobs", {
      method: "GET",
      query: `?site_id=eq.${encodeURIComponent(siteId)}&order=created_at.desc&limit=25`
    });
    return (rows ?? []).map(normalizeGenerationJob).reverse();
  }

  return [...memory.jobs.values()]
    .filter((job) => job.site_id === siteId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-25);
}

export async function getActiveGenerationJob(siteId: string): Promise<GenerationJob | null> {
  if (usesSupabase()) {
    const rows = await supabaseRequest<GenerationJob[]>("generation_jobs", {
      method: "GET",
      query: `?site_id=eq.${encodeURIComponent(siteId)}&status=in.(queued,running)&order=created_at.desc&limit=1`
    });
    return rows?.[0] ? normalizeGenerationJob(rows[0]) : null;
  }

  const memoryJob = [...memory.jobs.values()]
    .filter((job) => job.site_id === siteId && isGenerationJobActive(job))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (memoryJob) {
    return memoryJob;
  }

  return null;
}

async function getGenerationLock(siteId: string): Promise<GenerationLock | null> {
  const inMemory = memory.locks.get(siteId);
  if (inMemory) {
    return inMemory;
  }

  const rows = await supabaseRequest<GenerationLock[]>("generation_locks", {
    method: "GET",
    query: `?site_id=eq.${encodeURIComponent(siteId)}&limit=1`
  });
  return rows?.[0] ?? null;
}

async function deleteGenerationLock(siteId: string, jobId?: string): Promise<void> {
  const inMemory = memory.locks.get(siteId);
  if (!jobId || inMemory?.job_id === jobId) {
    memory.locks.delete(siteId);
  }

  const jobFilter = jobId ? `&job_id=eq.${encodeURIComponent(jobId)}` : "";
  await supabaseRequest("generation_locks", {
    method: "DELETE",
    query: `?site_id=eq.${encodeURIComponent(siteId)}${jobFilter}`
  });
}

async function tryClaimGenerationLock(siteId: string, jobId: string, force = false): Promise<boolean> {
  const now = nowIso();
  const lock: GenerationLock = {
    site_id: siteId,
    job_id: jobId,
    created_at: now,
    expires_at: lockExpiresAt()
  };

  if (!usesSupabase()) {
    const existing = memory.locks.get(siteId);
    if (!force && existing && !isExpired(existing.expires_at)) {
      return false;
    }
    memory.locks.set(siteId, lock);
    return true;
  }

  if (force) {
    try {
      await deleteGenerationLock(siteId);
    } catch (error) {
      console.warn("Could not clear existing generation lock before force claim.", error);
    }
  }

  try {
    await supabaseRequest<GenerationLock[]>("generation_locks", {
      method: "POST",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify(lock)
    });
    memory.locks.set(siteId, lock);
    return true;
  } catch (error) {
    if (!(error instanceof SupabaseRequestError) || error.status !== 409) {
      console.warn("Generation lock table is unavailable; falling back to non-atomic job claim.", error);
      memory.locks.set(siteId, lock);
      return true;
    }

    const existing = await getGenerationLock(siteId);
    if (existing && isExpired(existing.expires_at)) {
      await deleteGenerationLock(siteId, existing.job_id);
      return tryClaimGenerationLock(siteId, jobId, false);
    }

    return false;
  }
}

export async function createGenerationJob(
  siteId: string,
  trigger: GenerationJob["trigger"] = "system",
  options: { force?: boolean } = {}
): Promise<GenerationJob | null> {
  const now = nowIso();
  const job: GenerationJob = {
    id: crypto.randomUUID(),
    site_id: siteId,
    status: "queued",
    trigger,
    pages_total: 0,
    pages_done: 0,
    pages_failed: 0,
    last_error: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    finished_at: null
  };

  const claimed = await tryClaimGenerationLock(siteId, job.id, options.force);
  if (!claimed) {
    return null;
  }

  memory.jobs.set(job.id, job);

  if (usesSupabase()) {
    try {
      const rows = await supabaseRequest<GenerationJob[]>("generation_jobs", {
        method: "POST",
        headers: {
          Prefer: "return=representation"
        },
        body: JSON.stringify(job)
      });
      return rows?.[0] ? normalizeGenerationJob(rows[0]) : job;
    } catch (error) {
      try {
        const rows = await supabaseRequest<GenerationJob[]>("generation_jobs", {
          method: "POST",
          headers: {
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            id: job.id,
            site_id: job.site_id,
            status: job.status,
            created_at: job.created_at,
            updated_at: job.updated_at
          })
        });
        return rows?.[0] ? normalizeGenerationJob(rows[0]) : job;
      } catch (fallbackError) {
        await deleteGenerationLock(siteId, job.id);
        memory.jobs.delete(job.id);
        throw fallbackError;
      }
    }
  }

  return job;
}

export async function releaseGenerationJob(siteId: string, jobId: string): Promise<void> {
  try {
    await deleteGenerationLock(siteId, jobId);
  } catch (error) {
    console.warn("Could not release generation lock.", error);
  }
}

async function getSiteLlmTextLock(siteId: string, lang: string): Promise<SiteLlmTextLock | null> {
  const lockKey = siteLlmTextLockKey(siteId, lang);
  const inMemory = memory.llmTextLocks.get(lockKey);
  if (inMemory) {
    return inMemory;
  }

  const rows = await supabaseRequest<SiteLlmTextLock[]>("site_llm_text_locks", {
    method: "GET",
    query: `?lock_key=eq.${encodeURIComponent(lockKey)}&limit=1`
  });
  return rows?.[0] ?? null;
}

async function deleteSiteLlmTextLock(siteId: string, lang: string): Promise<void> {
  const lockKey = siteLlmTextLockKey(siteId, lang);
  memory.llmTextLocks.delete(lockKey);

  await supabaseRequest("site_llm_text_locks", {
    method: "DELETE",
    query: `?lock_key=eq.${encodeURIComponent(lockKey)}`
  });
}

export async function tryClaimSiteLlmTextLock(siteId: string, lang: string): Promise<boolean> {
  const lockKey = siteLlmTextLockKey(siteId, lang);
  const now = nowIso();
  const lock: SiteLlmTextLock = {
    lock_key: lockKey,
    site_id: siteId,
    lang,
    created_at: now,
    expires_at: llmTextLockExpiresAt()
  };

  if (!usesSupabase()) {
    const existing = memory.llmTextLocks.get(lockKey);
    if (existing && !isExpired(existing.expires_at)) {
      return false;
    }
    memory.llmTextLocks.set(lockKey, lock);
    return true;
  }

  try {
    await supabaseRequest<SiteLlmTextLock[]>("site_llm_text_locks", {
      method: "POST",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify(lock)
    });
    memory.llmTextLocks.set(lockKey, lock);
    return true;
  } catch (error) {
    if (!(error instanceof SupabaseRequestError) || error.status !== 409) {
      console.warn("LLM.txt lock table is unavailable; falling back to in-memory lock.", error);
      const existing = memory.llmTextLocks.get(lockKey);
      if (existing && !isExpired(existing.expires_at)) {
        return false;
      }
      memory.llmTextLocks.set(lockKey, lock);
      return true;
    }

    const existing = await getSiteLlmTextLock(siteId, lang);
    if (existing && isExpired(existing.expires_at)) {
      await deleteSiteLlmTextLock(siteId, lang);
      return tryClaimSiteLlmTextLock(siteId, lang);
    }

    return false;
  }
}

export async function releaseSiteLlmTextLock(siteId: string, lang: string): Promise<void> {
  try {
    await deleteSiteLlmTextLock(siteId, lang);
  } catch (error) {
    console.warn("Could not release LLM.txt generation lock.", error);
  }
}

export async function updateGenerationJob(jobId: string, patch: Partial<GenerationJob>): Promise<void> {
  const now = nowIso();
  const current = memory.jobs.get(jobId);
  if (current) {
    const next = { ...current, ...patch, updated_at: now };
    memory.jobs.set(jobId, next);
    if (patch.status === "queued" || patch.status === "running") {
      const lock = memory.locks.get(next.site_id);
      if (lock?.job_id === jobId) {
        memory.locks.set(next.site_id, { ...lock, expires_at: lockExpiresAt() });
      }
    }
  }

  try {
    await supabaseRequest("generation_jobs", {
      method: "PATCH",
      query: `?id=eq.${encodeURIComponent(jobId)}`,
      body: JSON.stringify({ ...patch, updated_at: now })
    });
  } catch {
    const minimalPatch: Record<string, unknown> = { updated_at: now };
    if (patch.status) {
      minimalPatch.status = patch.status;
    }
    await supabaseRequest("generation_jobs", {
      method: "PATCH",
      query: `?id=eq.${encodeURIComponent(jobId)}`,
      body: JSON.stringify(minimalPatch)
    });
  }
}

export async function upsertSourcePage(input: SourcePageInput): Promise<SourcePage> {
  let existing = [...memory.pages.values()].find(
    (page) => page.site_id === input.site_id && page.path === input.path
  );

  if (!existing && usesSupabase()) {
    const rows = await supabaseRequest<SourcePage[]>("source_pages", {
      method: "GET",
      query: `?site_id=eq.${encodeURIComponent(input.site_id)}&path=eq.${encodeURIComponent(input.path)}&limit=1`
    });
    existing = rows?.[0];
  }

  const now = nowIso();
  const page: SourcePage = {
    id: existing?.id ?? crypto.randomUUID(),
    discovered_at: existing?.discovered_at ?? now,
    updated_at: now,
    ...input
  };

  memory.pages.set(sourcePageMemoryKey(page.site_id, page.path), page);

  if (usesSupabase()) {
    const supabasePage = sourcePageForSupabase(page);
    try {
      const rows = await supabaseRequest<SourcePage[]>("source_pages", {
        method: "POST",
        headers: {
          Prefer: "resolution=merge-duplicates,return=representation"
        },
        query: "?on_conflict=site_id,path",
        body: JSON.stringify(supabasePage)
      });
      return rows?.[0] ? { ...rows[0], status: page.status } : page;
    } catch (error) {
      if (
        error instanceof SupabaseRequestError &&
        error.status === 400 &&
        error.body.includes("source_pages_status_check") &&
        page.status !== legacyPageStatus(page.status)
      ) {
        const rows = await supabaseRequest<SourcePage[]>("source_pages", {
          method: "POST",
          headers: {
            Prefer: "resolution=merge-duplicates,return=representation"
          },
          query: "?on_conflict=site_id,path",
          body: JSON.stringify(supabasePage)
        });
        return rows?.[0] ? { ...rows[0], status: page.status } : page;
      }

      throw error;
    }
  }

  return page;
}

export async function bulkUpsertSourcePages(inputs: SourcePageInput[], existingPages: SourcePage[] = []): Promise<SourcePage[]> {
  if (inputs.length === 0) {
    return [];
  }

  const now = nowIso();
  const existingRows =
    existingPages.length > 0 || !usesSupabase()
      ? existingPages
      : (
          await Promise.all(
            [...new Set(inputs.map((input) => input.site_id))].map((siteId) => listSourcePages(siteId))
          )
        ).flat();
  const existingByKey = new Map<string, SourcePage>();
  for (const page of existingRows) {
    existingByKey.set(sourcePageMemoryKey(page.site_id, page.path), page);
  }
  for (const page of memory.pages.values()) {
    existingByKey.set(sourcePageMemoryKey(page.site_id, page.path), page);
  }

  const pages = inputs.map((input) => {
    const existing = existingByKey.get(sourcePageMemoryKey(input.site_id, input.path));
    return {
      id: existing?.id ?? crypto.randomUUID(),
      discovered_at: existing?.discovered_at ?? now,
      updated_at: now,
      ...input
    };
  });

  for (const page of pages) {
    memory.pages.set(sourcePageMemoryKey(page.site_id, page.path), page);
  }

  if (!usesSupabase()) {
    return pages;
  }

  const supabasePages = pages.map(sourcePageForSupabase);
  const pageByKey = new Map(pages.map((page) => [sourcePageMemoryKey(page.site_id, page.path), page]));
  const restorePageStatus = (rows: SourcePage[]): SourcePage[] =>
    rows.map((row) => ({
      ...row,
      status: pageByKey.get(sourcePageMemoryKey(row.site_id, row.path))?.status ?? row.status
    }));

  try {
    const rows: SourcePage[] = [];
    for (const chunk of chunks(supabasePages, 100)) {
      rows.push(
        ...((await supabaseRequest<SourcePage[]>("source_pages", {
          method: "POST",
          headers: {
            Prefer: "resolution=merge-duplicates,return=representation"
          },
          query: "?on_conflict=site_id,path",
          body: JSON.stringify(chunk)
        })) ?? [])
      );
    }
    return rows.length > 0 ? restorePageStatus(rows) : pages;
  } catch (error) {
    if (
      error instanceof SupabaseRequestError &&
      error.status === 400 &&
      error.body.includes("source_pages_status_check")
    ) {
      const rows: SourcePage[] = [];
      for (const chunk of chunks(supabasePages, 100)) {
        rows.push(
          ...((await supabaseRequest<SourcePage[]>("source_pages", {
            method: "POST",
            headers: {
              Prefer: "resolution=merge-duplicates,return=representation"
            },
            query: "?on_conflict=site_id,path",
            body: JSON.stringify(chunk)
          })) ?? [])
        );
      }
      return rows.length > 0 ? restorePageStatus(rows) : pages;
    }

    throw error;
  }
}

export async function listSourcePages(siteId: string): Promise<SourcePage[]> {
  if (usesSupabase()) {
    const rows = await supabaseRequest<SourcePage[]>("source_pages", {
      method: "GET",
      query: `?site_id=eq.${encodeURIComponent(siteId)}&order=path.asc`
    });
    return rows ?? [];
  }

  return [...memory.pages.values()].filter((page) => page.site_id === siteId).sort((a, b) => a.path.localeCompare(b.path));
}

export async function getSourcePage(siteId: string, path: string): Promise<SourcePage | null> {
  for (const candidate of mirrorPathCandidates(path)) {
    if (usesSupabase()) {
      const rows = await supabaseRequest<SourcePage[]>("source_pages", {
        method: "GET",
        query: `?site_id=eq.${encodeURIComponent(siteId)}&path=eq.${encodeURIComponent(candidate)}&limit=1`
      });
      if (rows?.[0]) {
        return rows[0];
      }
    } else {
      const inMemory = memory.pages.get(sourcePageMemoryKey(siteId, candidate));
      if (inMemory) {
        return inMemory;
      }
    }
  }

  return null;
}

export async function getSourcePageById(siteId: string, pageId: string): Promise<SourcePage | null> {
  if (usesSupabase()) {
    const rows = await supabaseRequest<SourcePage[]>("source_pages", {
      method: "GET",
      query: `?site_id=eq.${encodeURIComponent(siteId)}&id=eq.${encodeURIComponent(pageId)}&limit=1`
    });
    return rows?.[0] ?? null;
  }

  return [...memory.pages.values()].find((page) => page.site_id === siteId && page.id === pageId) ?? null;
}

export async function upsertMirroredPage(
  input: Omit<MirroredPage, "id" | "generated_at" | "updated_at">
): Promise<MirroredPage> {
  const existing = [...memory.mirrored.values()].find(
    (page) => page.site_id === input.site_id && page.lang === input.lang && page.path === input.path
  );
  const now = nowIso();
  const page: MirroredPage = {
    id: existing?.id ?? crypto.randomUUID(),
    generated_at: existing?.generated_at ?? now,
    updated_at: now,
    ...input
  };

  memory.mirrored.set(mirroredPageMemoryKey(page.site_id, page.lang, page.path), page);

  if (usesSupabase()) {
    const rows = await supabaseRequest<MirroredPage[]>("mirrored_pages", {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      query: "?on_conflict=site_id,lang,path",
      body: JSON.stringify(page)
    });
    return rows?.[0] ?? page;
  }

  return page;
}

export async function getMirroredPage(siteId: string, lang: string, path: string): Promise<MirroredPage | null> {
  for (const candidate of mirrorPathCandidates(path)) {
    if (usesSupabase()) {
      const rows = await supabaseRequest<MirroredPage[]>("mirrored_pages", {
        method: "GET",
        query: `?site_id=eq.${encodeURIComponent(siteId)}&lang=eq.${encodeURIComponent(lang)}&path=eq.${encodeURIComponent(candidate)}&limit=1`
      });
      if (rows?.[0]) {
        return rows[0];
      }
    } else {
      const inMemory = memory.mirrored.get(mirroredPageMemoryKey(siteId, lang, candidate));
      if (inMemory) {
        return inMemory;
      }
    }
  }

  return null;
}

export async function getSiteProgress(slug: string): Promise<SiteProgress | null> {
  const site = await getDocSiteBySlug(slug);
  if (!site) {
    return null;
  }

  const [pages, mirroredPages, llmTexts, events, jobs] = await Promise.all([
    listSourcePages(site.id),
    listMirroredPages(site.id),
    listSiteLlmTexts(site.id),
    listJobEvents(site.id),
    listGenerationJobs(site.id)
  ]);
  const liveCounts = {
    discovered_count: pages.length,
    generated_count: mirroredPages.length,
    failed_count: pages.filter((page) => page.status === "failed").length
  };
  const countersChanged =
    site.discovered_count !== liveCounts.discovered_count ||
    site.generated_count !== liveCounts.generated_count ||
    site.failed_count !== liveCounts.failed_count;

  if (countersChanged) {
    await updateDocSite(site.id, liveCounts);
  }

  return {
    site: { ...site, ...liveCounts },
    pages: pages.map(({ site_id: _siteId, ...page }) => page),
    mirroredPages: mirroredPages.map(({ lang, path, source_html_hash, generated_at }) => ({
      lang,
      path,
      source_html_hash,
      generated_at
    })),
    llmTexts: llmTexts.map(({ lang, page_count, generated_at, updated_at }) => ({
      lang,
      page_count,
      generated_at,
      updated_at
    })),
    events,
    jobs
  };
}

export async function findMirrorTargetByPath(path: string): Promise<{
  site: DocSite;
  lang: string;
  path: string;
  generated: boolean;
} | null> {
  const candidates = new Set(mirrorPathCandidates(path));
  const sites = await listDocSites();

  for (const site of sites) {
    const mirroredPages = await listMirroredPages(site.id);
    const mirrored = mirroredPages.find((page) => candidates.has(page.path));
    if (mirrored) {
      return {
        site,
        lang: mirrored.lang,
        path: mirrored.path,
        generated: true
      };
    }

    const sourcePages = await listSourcePages(site.id);
    const source = sourcePages.find((page) => candidates.has(page.path));
    if (source) {
      return {
        site,
        lang: site.target_langs[0],
        path: source.path,
        generated: false
      };
    }
  }

  return null;
}

export async function listMirroredPages(siteId: string): Promise<MirroredPageSummary[]> {
  if (usesSupabase()) {
    const rows = await supabaseRequest<MirroredPageSummary[]>("mirrored_pages", {
      method: "GET",
      query: `?select=id,site_id,source_page_id,lang,path,source_html_hash,generated_at,updated_at&site_id=eq.${encodeURIComponent(siteId)}&order=lang.asc,path.asc`
    });
    return rows ?? [];
  }

  return [...memory.mirrored.values()]
    .filter((page) => page.site_id === siteId)
    .map(({ html: _html, ...page }) => page)
    .sort((a, b) => `${a.lang}:${a.path}`.localeCompare(`${b.lang}:${b.path}`));
}

export async function listMirroredPagesWithHtml(siteId: string, lang: string): Promise<MirroredPage[]> {
  if (usesSupabase()) {
    const rows = await supabaseRequest<MirroredPage[]>("mirrored_pages", {
      method: "GET",
      query: `?site_id=eq.${encodeURIComponent(siteId)}&lang=eq.${encodeURIComponent(lang)}&order=path.asc`
    });
    return rows ?? [];
  }

  return [...memory.mirrored.values()]
    .filter((page) => page.site_id === siteId && page.lang === lang)
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function listMirroredPagesForSites(siteIds: string[]): Promise<Map<string, MirroredPageSummary[]>> {
  const result = new Map<string, MirroredPageSummary[]>();
  for (const siteId of siteIds) {
    result.set(siteId, []);
  }

  if (siteIds.length === 0) {
    return result;
  }

  if (!usesSupabase()) {
    for (const page of memory.mirrored.values()) {
      if (!result.has(page.site_id)) {
        continue;
      }

      const { html: _html, ...summary } = page;
      result.get(page.site_id)?.push(summary);
    }
  } else {
    const rows =
      (await supabaseRequest<MirroredPageSummary[]>("mirrored_pages", {
        method: "GET",
        query: `?select=id,site_id,source_page_id,lang,path,source_html_hash,generated_at,updated_at&site_id=in.(${siteIds
          .map(encodeURIComponent)
          .join(",")})&order=site_id.asc,lang.asc,path.asc`
      })) ?? [];

    for (const row of rows) {
      result.get(row.site_id)?.push(row);
    }
  }

  for (const pages of result.values()) {
    pages.sort((a, b) => `${a.lang}:${a.path}`.localeCompare(`${b.lang}:${b.path}`));
  }

  return result;
}

export async function upsertSiteLlmText(
  input: Omit<SiteLlmText, "generated_at" | "updated_at">
): Promise<SiteLlmText> {
  const key = siteLlmTextMemoryKey(input.site_id, input.lang);
  const existing = memory.llmTexts.get(key);
  const now = nowIso();
  const llmText: SiteLlmText = {
    generated_at: existing?.generated_at ?? now,
    updated_at: now,
    ...input
  };

  memory.llmTexts.set(key, llmText);

  if (usesSupabase()) {
    const rows = await supabaseRequest<SiteLlmText[]>("site_llm_texts", {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      query: "?on_conflict=site_id,lang",
      body: JSON.stringify(llmText)
    });
    return rows?.[0] ?? llmText;
  }

  return llmText;
}

export async function getSiteLlmText(siteId: string, lang: string): Promise<SiteLlmText | null> {
  const inMemory = memory.llmTexts.get(siteLlmTextMemoryKey(siteId, lang));
  if (inMemory) {
    return inMemory;
  }

  const rows = await supabaseRequest<SiteLlmText[]>("site_llm_texts", {
    method: "GET",
    query: `?site_id=eq.${encodeURIComponent(siteId)}&lang=eq.${encodeURIComponent(lang)}&limit=1`
  }).catch((error) => {
    console.warn("Could not load site LLM text.", error);
    return null;
  });
  return rows?.[0] ?? null;
}

export async function listSiteLlmTexts(siteId: string): Promise<SiteLlmText[]> {
  if (usesSupabase()) {
    const supabaseRows = await supabaseRequest<Array<Omit<SiteLlmText, "content">>>("site_llm_texts", {
      method: "GET",
      query: `?site_id=eq.${encodeURIComponent(siteId)}&select=site_id,lang,page_count,generated_at,updated_at&order=lang.asc`
    }).catch((error) => {
      console.warn("Could not load site LLM text metadata.", error);
      return null;
    });
    return (supabaseRows ?? []).map((row) => ({ ...row, content: "" }));
  }

  return [...memory.llmTexts.values()].filter((item) => item.site_id === siteId).sort((a, b) => a.lang.localeCompare(b.lang));
}

export async function listSiteLlmTextsForSites(siteIds: string[]): Promise<Map<string, SiteLlmText[]>> {
  const result = new Map<string, SiteLlmText[]>();
  for (const siteId of siteIds) {
    result.set(siteId, []);
  }

  if (siteIds.length === 0) {
    return result;
  }

  if (!usesSupabase()) {
    for (const item of memory.llmTexts.values()) {
      if (result.has(item.site_id)) {
        result.get(item.site_id)?.push(item);
      }
    }
  } else {
    const rows =
      (await supabaseRequest<Array<Omit<SiteLlmText, "content">>>("site_llm_texts", {
        method: "GET",
        query: `?site_id=in.(${siteIds
          .map(encodeURIComponent)
          .join(",")})&select=site_id,lang,page_count,generated_at,updated_at&order=site_id.asc,lang.asc`
      }).catch((error) => {
        console.warn("Could not load site LLM text metadata.", error);
        return null;
      })) ?? [];

    for (const row of rows) {
      result.get(row.site_id)?.push({ ...row, content: "" });
    }
  }

  for (const items of result.values()) {
    items.sort((a, b) => a.lang.localeCompare(b.lang));
  }

  return result;
}

export async function listJobEvents(siteId: string): Promise<JobEvent[]> {
  if (usesSupabase()) {
    const rows = await supabaseRequest<JobEvent[]>("job_events", {
      method: "GET",
      query: `?site_id=eq.${encodeURIComponent(siteId)}&order=created_at.desc&limit=50`
    });
    return (rows ?? []).reverse();
  }

  return [...memory.events.values()]
    .filter((event) => event.site_id === siteId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-50);
}

export async function listLatestJobEventsForSites(siteIds: string[]): Promise<Map<string, JobEvent | null>> {
  const result = new Map<string, JobEvent | null>();
  for (const siteId of siteIds) {
    result.set(siteId, null);
  }

  if (siteIds.length === 0) {
    return result;
  }

  if (!usesSupabase()) {
    for (const siteId of siteIds) {
      const latest = [...memory.events.values()]
        .filter((event) => event.site_id === siteId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      result.set(siteId, latest ?? null);
    }
    return result;
  }

  const rows =
    (await supabaseRequest<JobEvent[]>("job_events", {
      method: "GET",
      query: `?site_id=in.(${siteIds
        .map(encodeURIComponent)
        .join(",")})&order=created_at.desc&limit=${Math.min(siteIds.length * 10, 1000)}`
    })) ?? [];

  for (const event of rows) {
    if (!result.get(event.site_id)) {
      result.set(event.site_id, event);
    }
  }

  return result;
}


function emptyVoteStats(): SiteVoteStats {
  return {
    upvote_count: 0,
    downvote_count: 0,
    vote_score: 0,
    user_vote: 0
  };
}

function voteStatsForRows(rows: SiteVote[], voterKey?: string): SiteVoteStats {
  const upvote_count = rows.filter((vote) => vote.value === 1).length;
  const downvote_count = rows.filter((vote) => vote.value === -1).length;
  const user_vote = voterKey ? rows.find((vote) => vote.voter_key === voterKey)?.value ?? 0 : 0;
  return {
    upvote_count,
    downvote_count,
    vote_score: upvote_count - downvote_count,
    user_vote
  };
}

export async function getSiteVoteStats(siteId: string, voterKey?: string): Promise<SiteVoteStats> {
  if (!usesSupabase()) {
    const rows = [...memory.votes.values()].filter((vote) => vote.site_id === siteId);
    return voteStatsForRows(rows, voterKey);
  }

  const rows = await supabaseRequest<SiteVote[]>("site_votes", {
    method: "GET",
    query: `?site_id=eq.${encodeURIComponent(siteId)}`
  }).catch((error) => {
    console.warn("Could not load site vote stats.", error);
    return null;
  });
  return voteStatsForRows(rows ?? [], voterKey);
}

export async function listSiteVoteStats(siteIds: string[], voterKey?: string): Promise<Map<string, SiteVoteStats>> {
  const stats = new Map<string, SiteVoteStats>();
  for (const siteId of siteIds) {
    stats.set(siteId, emptyVoteStats());
  }

  if (siteIds.length === 0) {
    return stats;
  }

  if (!usesSupabase()) {
    const rowsBySite = new Map<string, SiteVote[]>();
    for (const vote of memory.votes.values()) {
      if (!stats.has(vote.site_id)) {
        continue;
      }
      const rows = rowsBySite.get(vote.site_id) ?? [];
      rows.push(vote);
      rowsBySite.set(vote.site_id, rows);
    }
    for (const siteId of siteIds) {
      stats.set(siteId, voteStatsForRows(rowsBySite.get(siteId) ?? [], voterKey));
    }
    return stats;
  }

  const rows = await supabaseRequest<SiteVote[]>("site_votes", {
    method: "GET",
    query: `?site_id=in.(${siteIds.map(encodeURIComponent).join(",")})`
  }).catch((error) => {
    console.warn("Could not load site vote stats.", error);
    return null;
  });

  const rowsBySite = new Map<string, SiteVote[]>();
  for (const vote of rows ?? []) {
    const siteVotes = rowsBySite.get(vote.site_id) ?? [];
    siteVotes.push(vote);
    rowsBySite.set(vote.site_id, siteVotes);
  }

  for (const siteId of siteIds) {
    stats.set(siteId, voteStatsForRows(rowsBySite.get(siteId) ?? [], voterKey));
  }

  return stats;
}

export async function setSiteVote(siteId: string, voterKey: string, value: -1 | 0 | 1): Promise<SiteVoteStats> {
  const key = siteVoteMemoryKey(siteId, voterKey);
  const now = nowIso();

  if (value === 0) {
    memory.votes.delete(key);
    await supabaseRequest("site_votes", {
      method: "DELETE",
      query: `?site_id=eq.${encodeURIComponent(siteId)}&voter_key=eq.${encodeURIComponent(voterKey)}`
    });
    return getSiteVoteStats(siteId, voterKey);
  }

  const current = memory.votes.get(key);
  const vote: SiteVote = {
    site_id: siteId,
    voter_key: voterKey,
    value,
    created_at: current?.created_at ?? now,
    updated_at: now
  };
  memory.votes.set(key, vote);

  await supabaseRequest<SiteVote[]>("site_votes", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation"
    },
    query: "?on_conflict=site_id,voter_key",
    body: JSON.stringify(vote)
  });

  return getSiteVoteStats(siteId, voterKey);
}

export async function recomputeSiteCounters(siteId: string, status?: SiteStatus): Promise<void> {
  const [pages, mirrored] = await Promise.all([listSourcePages(siteId), listMirroredPages(siteId)]);
  await updateDocSite(siteId, {
    ...(status ? { status } : {}),
    discovered_count: pages.length,
    generated_count: mirrored.length,
    failed_count: pages.filter((page) => page.status === "failed").length
  });
}
