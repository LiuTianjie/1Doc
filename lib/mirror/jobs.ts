import { generateMirrorSite } from "./generator";
import {
  addJobEvent,
  createGenerationJob,
  getActiveGenerationJob,
  getDocSiteById,
  releaseGenerationJob,
  updateDocSite,
  updateGenerationJob
} from "./store";
import type { GenerationJob, GenerationMode } from "./types";

type InngestLike = {
  send: (event: { name: string; data: Record<string, unknown> }) => Promise<unknown>;
};

function isStale(updatedAt: string): boolean {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) {
    return true;
  }

  return Date.now() - timestamp > 5 * 60 * 1000;
}

function isComplete(site: Awaited<ReturnType<typeof getDocSiteById>>): boolean {
  if (!site || site.status !== "ready" || site.discovered_count === 0) {
    return false;
  }

  return site.generated_count >= site.discovered_count * site.target_langs.length;
}

function isActiveSiteStatus(status: string): boolean {
  return status === "queued" || status === "discovering" || status === "generating";
}

export async function enqueueMirrorGeneration(
  siteId: string,
  inngest?: InngestLike,
  options: { force?: boolean; trigger?: GenerationJob["trigger"]; mode?: GenerationMode } = {}
): Promise<"queued" | "inline" | "skipped"> {
  const site = await getDocSiteById(siteId);
  if (!site) {
    throw new Error(`Site ${siteId} was not found.`);
  }

  if (!options.force) {
    const activeJob = await getActiveGenerationJob(siteId);
    if (activeJob && !isStale(activeJob.updated_at)) {
      return "skipped";
    }

    if (isComplete(site)) {
      return "skipped";
    }
  }

  const job = await createGenerationJob(siteId, options.trigger ?? "system", { force: options.force });
  if (!job) {
    return "skipped";
  }

  if (inngest && (process.env.INNGEST_EVENT_KEY || process.env.INNGEST_DEV === "1")) {
    await updateDocSite(siteId, { status: "queued", last_error: null });
    await inngest.send({
      name: "site/mirror.requested",
      data: { siteId, jobId: job.id, mode: options.mode ?? "incremental" }
    });
    return "queued";
  }

  // Local fallback: keep the create request responsive without an external queue worker.
  void generateMirrorSite(siteId, job.id, { mode: options.mode ?? "incremental" })
    .catch((error) => {
      console.error("Local mirror generation failed", error);
    });
  return "inline";
}

export async function recoverStaleMirrorGeneration(
  siteId: string,
  inngest?: InngestLike,
  options: { trigger?: GenerationJob["trigger"]; mode?: GenerationMode } = {}
): Promise<"queued" | "inline" | "skipped"> {
  const site = await getDocSiteById(siteId);
  if (!site || isComplete(site)) {
    return "skipped";
  }

  const activeJob = await getActiveGenerationJob(siteId);
  const staleJob = activeJob && isStale(activeJob.updated_at) ? activeJob : null;
  const staleSite = isActiveSiteStatus(site.status) && isStale(site.updated_at);

  if (!staleJob && !staleSite) {
    return "skipped";
  }

  if (staleJob) {
    await updateGenerationJob(staleJob.id, {
      status: "failed",
      last_error: "Generation was interrupted and automatically recovered.",
      finished_at: new Date().toISOString()
    });
    await releaseGenerationJob(siteId, staleJob.id);
  }

  await addJobEvent(siteId, "info", "Recovering interrupted generation", {
    staleJobId: staleJob?.id ?? null,
    previousStatus: site.status
  });

  await updateDocSite(siteId, { status: "queued", last_error: null });
  return enqueueMirrorGeneration(siteId, inngest, {
    force: true,
    trigger: options.trigger ?? "system",
    mode: options.mode ?? "incremental"
  });
}
