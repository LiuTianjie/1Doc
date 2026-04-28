import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { functions } from "@/inngest/functions";

export const runtime = "nodejs";
export const maxDuration = 300;

function notConfigured() {
  return Response.json(
    {
      status: "disabled",
      message: "Set INNGEST_DEV=1 for local Inngest dev mode or INNGEST_SIGNING_KEY for production."
    },
    { status: 503 }
  );
}

const handlers =
  process.env.INNGEST_DEV === "1" || process.env.INNGEST_SIGNING_KEY
    ? serve({
        client: inngest,
        functions,
        streaming: true
      })
    : {
        GET: notConfigured,
        POST: notConfigured,
        PUT: notConfigured
      };

export const { GET, POST, PUT } = handlers;
