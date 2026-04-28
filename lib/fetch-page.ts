import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { assertPublicUrl, isBlockedNetworkHost, normalizeUserUrl } from "./url";

type FetchPageResult = {
  html: string;
  finalUrl: string;
  rendered: boolean;
};

const USER_AGENT =
  "1Doc/0.1 (+https://example.com; public documentation mirror generator)";
const MAX_REDIRECTS = 5;

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeSpaShell(html: string): boolean {
  const text = stripTags(html);
  return text.length < 200 && /<script[\s\S]+src=/i.test(html);
}

function networkErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Target fetch failed.";
  }

  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const code = typeof cause?.code === "string" ? cause.code : "";
  const causeMessage = typeof cause?.message === "string" ? cause.message : "";
  const detail = [code, causeMessage].filter(Boolean).join(": ");
  return detail ? `Target fetch failed (${detail}).` : `Target fetch failed (${error.message}).`;
}

function browserlessContentUrl(): string | null {
  const configured = process.env.BROWSERLESS_WS_URL;
  if (!configured) {
    return null;
  }

  const url = new URL(configured);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/content";
  return url.toString();
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function assertPublicFetchUrl(url: URL): Promise<void> {
  assertPublicUrl(url);
  if (isIP(url.hostname)) {
    return;
  }

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.some((address) => isBlockedNetworkHost(address.address))) {
    throw new Error("Target hostname resolves to a private or local address.");
  }
}

async function fetchStaticHtml(url: string): Promise<FetchPageResult> {
  return withTimeout(async (signal) => {
    let currentUrl = normalizeUserUrl(url);
    let response: Response | null = null;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      await assertPublicFetchUrl(currentUrl);
      try {
        response = await fetch(currentUrl, {
          headers: {
            accept: "text/html,application/xhtml+xml",
            "user-agent": USER_AGENT
          },
          redirect: "manual",
          signal,
          cache: "no-store"
        });
      } catch (error) {
        throw new Error(networkErrorMessage(error), { cause: error });
      }

      if (![301, 302, 303, 307, 308].includes(response.status)) {
        break;
      }

      const location = response.headers.get("location");
      if (!location) {
        break;
      }
      currentUrl = normalizeUserUrl(new URL(location, currentUrl).toString());
      response = null;
    }

    if (!response) {
      throw new Error("Target returned too many redirects.");
    }

    if (!response.ok) {
      throw new Error(`Target returned ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error("Target URL did not return HTML.");
    }

    return {
      html: await response.text(),
      finalUrl: currentUrl.toString(),
      rendered: false
    };
  }, 15000);
}

async function fetchRenderedHtml(url: string): Promise<FetchPageResult | null> {
  const endpoint = browserlessContentUrl();
  if (!endpoint) {
    return null;
  }

  return withTimeout(async (signal) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        url,
        gotoOptions: {
          waitUntil: "networkidle2",
          timeout: 25000
        }
      }),
      signal,
      cache: "no-store"
    });

    if (!response.ok) {
      return null;
    }

    return {
      html: await response.text(),
      finalUrl: url,
      rendered: true
    };
  }, 30000);
}

export async function fetchPage(url: string): Promise<FetchPageResult> {
  normalizeUserUrl(url);
  const staticResult = await fetchStaticHtml(url);
  if (!looksLikeSpaShell(staticResult.html)) {
    return staticResult;
  }

  const rendered = await fetchRenderedHtml(staticResult.finalUrl);
  return rendered ?? staticResult;
}
