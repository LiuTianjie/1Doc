import { generateMirrorSite } from "@/lib/mirror/generator";
import type { GenerationMode } from "@/lib/mirror/types";
import { inngest } from "./client";

export const generateMirrorSiteFunction = inngest.createFunction(
  { id: "generate-mirror-site", triggers: { event: "site/mirror.requested" } },
  async ({ event, step }) => {
    const siteId = event.data.siteId;
    const jobId = event.data.jobId;
    const mode = event.data.mode;
    if (typeof siteId !== "string") {
      throw new Error("Missing siteId.");
    }
    const generationMode: GenerationMode =
      mode === "retry_failed" || mode === "refresh_existing" ? mode : "incremental";

    await step.run("generate mirror", async () => {
      await generateMirrorSite(siteId, typeof jobId === "string" ? jobId : undefined, {
        mode: generationMode
      });
      return { siteId };
    });

    return { siteId };
  }
);

export const functions = [generateMirrorSiteFunction];
