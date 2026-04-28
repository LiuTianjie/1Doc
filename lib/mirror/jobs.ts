import { generateMirrorSite } from "./generator";
import { createGenerationJob, getActiveGenerationJob, getDocSiteById, updateDocSite } from "./store";
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
