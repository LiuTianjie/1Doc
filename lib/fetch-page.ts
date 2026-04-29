import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { assertPublicUrl, isBlockedNetworkHost, normalizeUserUrl } from "./url";

export type FetchMode = "static" | "rendered" | "rendered_with_expansion";

export type FetchErrorCode =
  | "blocked_url"
  | "empty_dom"
  | "http_error"
  | "network_error"
  | "non_html"
  | "render_crash"
  | "render_unavailable"
  | "timeout"
  | "too_many_redirects"
  | "unknown";

export type FetchPageResult = {
  html: string;
  finalUrl: string;
  rendered: boolean;
  fetchMode: FetchMode;
};

export class FetchPageError extends Error {
  constructor(
    message: string,
    readonly code: FetchErrorCode,
    readonly fetchMode: FetchMode,
    readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

const USER_AGENT =
  "1Doc/0.1 (+https://example.com; public documentation mirror generator)";
const MAX_REDIRECTS = 5;
const RENDER_WAIT_MS = 1000;
const RENDER_TIMEOUT_MS = 30000;

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

function browserlessWsUrl(): string | null {
  return process.env.BROWSERLESS_WS_URL || null;
}

function browserlessContentUrl(): string | null {
  const configured = browserlessWsUrl();
  if (!configured) {
    return null;
  }

  const url = new URL(configured);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/content";
  return url.toString();
}

export function hasBrowserRenderer(): boolean {
  return Boolean(browserlessWsUrl());
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new DOMException("Operation timed out.", "AbortError"));
        }, ms);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function assertPublicFetchUrl(url: URL): Promise<void> {
  try {
    assertPublicUrl(url);
  } catch (error) {
    throw new FetchPageError(error instanceof Error ? error.message : "Target URL is blocked.", "blocked_url", "static", undefined, {
      cause: error
    });
  }
  if (isIP(url.hostname)) {
    return;
  }

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.some((address) => isBlockedNetworkHost(address.address))) {
    throw new FetchPageError("Target hostname resolves to a private or local address.", "blocked_url", "static");
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
        const code = error instanceof DOMException && error.name === "AbortError" ? "timeout" : "network_error";
        throw new FetchPageError(networkErrorMessage(error), code, "static", undefined, { cause: error });
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
      throw new FetchPageError("Target returned too many redirects.", "too_many_redirects", "static");
    }

    if (!response.ok) {
      throw new FetchPageError(`Target returned ${response.status}.`, "http_error", "static", response.status);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new FetchPageError("Target URL did not return HTML.", "non_html", "static", response.status);
    }

    return {
      html: await response.text(),
      finalUrl: currentUrl.toString(),
      rendered: false,
      fetchMode: "static"
    };
  }, 15000);
}

function emptyHtml(html: string): boolean {
  return html.trim().length < 20 || stripTags(html).length === 0;
}

function renderError(error: unknown, mode: Exclude<FetchMode, "static">): FetchPageError {
  if (error instanceof FetchPageError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new FetchPageError("Browser renderer timed out.", "timeout", mode, undefined, { cause: error });
  }

  return new FetchPageError(
    error instanceof Error ? error.message : "Browser renderer failed.",
    "render_crash",
    mode,
    undefined,
    { cause: error }
  );
}

async function fetchRenderedContentHtml(url: string): Promise<FetchPageResult | null> {
  const endpoint = browserlessContentUrl();
  if (!endpoint) {
    return null;
  }

  return withTimeout(async (signal) => {
    await assertPublicFetchUrl(normalizeUserUrl(url));
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
      throw new FetchPageError(`Browser renderer returned ${response.status}.`, "render_crash", "rendered", response.status);
    }

    const html = await response.text();
    if (emptyHtml(html)) {
      throw new FetchPageError("Browser renderer returned an empty document.", "empty_dom", "rendered");
    }

    return {
      html,
      finalUrl: url,
      rendered: true,
      fetchMode: "rendered"
    };
  }, RENDER_TIMEOUT_MS);
}

function expansionScript(): string {
  return `async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clicked = new WeakSet();
    let count = 0;

    document.addEventListener("submit", (event) => event.preventDefault(), true);
    document.addEventListener("click", (event) => {
      const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") || "";
      if (href && !href.startsWith("#")) event.preventDefault();
    }, true);

    const selectors = [
      "details:not([open]) > summary",
      "[aria-expanded='false'][aria-controls]",
      "button[aria-expanded='false']",
      "[role='button'][aria-expanded='false']",
      "[data-state='closed']",
      "[data-headlessui-state]:not([data-headlessui-state~='open'])",
      ".menu__caret",
      ".navbar-sidebar__toggle",
      ".sidebar-toggle",
      ".toggle"
    ];

    function visible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function safe(element) {
      if (clicked.has(element) || !visible(element)) return false;
      if (element.closest("form")) return false;
      const button = element.closest("button");
      if (button && (button.getAttribute("type") || "").toLowerCase() === "submit") return false;
      const anchor = element.closest("a[href]");
      const href = anchor ? anchor.getAttribute("href") || "" : "";
      if (href && !href.startsWith("#")) return false;
      const text = (element.textContent || "").toLowerCase();
      return !/\\b(sign in|login|log in|logout|download|delete|remove|submit|search)\\b/.test(text);
    }

    for (let pass = 0; pass < 4; pass += 1) {
      const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).slice(0, 80);
      let passClicks = 0;
      for (const candidate of candidates) {
        if (!safe(candidate)) continue;
        clicked.add(candidate);
        candidate.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        count += 1;
        passClicks += 1;
        await sleep(80);
      }
      if (passClicks === 0) break;
      await sleep(350);
    }

    return count;
  }`;
}

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
  sessionId?: string;
};

async function fetchRenderedWithCdp(url: string, expand: boolean): Promise<FetchPageResult | null> {
  const endpoint = browserlessWsUrl();
  if (!endpoint) {
    return null;
  }

  return withTimeout(async (signal) => {
    await assertPublicFetchUrl(normalizeUserUrl(url));
    const socket = new WebSocket(endpoint);
    let nextId = 1;
    let targetId: string | null = null;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const listeners = new Set<(message: CdpMessage) => void>();

    function send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
      const id = nextId;
      nextId += 1;
      const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(payload);
      });
    }

    signal.addEventListener("abort", () => socket.close(), { once: true });

    function waitForEvent(predicate: (message: CdpMessage) => boolean, ms: number): Promise<void> {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          listeners.delete(listener);
          resolve();
        }, ms);
        const listener = (message: CdpMessage) => {
          if (!predicate(message)) {
            return;
          }
          clearTimeout(timeout);
          listeners.delete(listener);
          resolve();
        };
        listeners.add(listener);
      });
    }

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Browser renderer websocket failed.")), { once: true });
    });

    socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      const message = JSON.parse(text) as CdpMessage;
      if (typeof message.id === "number") {
        const entry = pending.get(message.id);
        if (!entry) {
          return;
        }
        pending.delete(message.id);
        if (message.error) {
          entry.reject(new Error(message.error.message || "Browser renderer command failed."));
        } else {
          entry.resolve(message.result);
        }
        return;
      }
      for (const listener of listeners) {
        listener(message);
      }
    });

    socket.addEventListener("close", () => {
      for (const entry of pending.values()) {
        entry.reject(new Error("Browser renderer websocket closed."));
      }
      pending.clear();
      listeners.clear();
    });

    try {
      const created = await send("Target.createTarget", { url: "about:blank" });
      targetId = typeof created?.targetId === "string" ? created.targetId : null;
      const attached = await send("Target.attachToTarget", { targetId, flatten: true });
      const sessionId = typeof attached?.sessionId === "string" ? attached.sessionId : "";
      if (!sessionId) {
        throw new Error("Browser renderer did not create a page session.");
      }

      await send("Page.enable", {}, sessionId);
      await send("Runtime.enable", {}, sessionId);
      await send("Network.enable", {}, sessionId);
      await send("Network.setUserAgentOverride", { userAgent: USER_AGENT }, sessionId);
      await send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);

      const loaded = waitForEvent(
        (message) =>
          message.sessionId === sessionId &&
          (message.method === "Page.loadEventFired" ||
            (message.method === "Page.lifecycleEvent" && message.params?.name === "networkIdle")),
        25000
      );
      await send("Page.navigate", { url }, sessionId);
      await loaded;
      await new Promise((resolve) => setTimeout(resolve, RENDER_WAIT_MS));

      let expansionClicks = 0;
      if (expand) {
        const expanded = await send(
          "Runtime.evaluate",
          {
            expression: `(${expansionScript()})()`,
            awaitPromise: true,
            returnByValue: true
          },
          sessionId
        );
        expansionClicks = typeof expanded?.result?.value === "number" ? expanded.result.value : 0;
        if (expansionClicks > 0) {
          await new Promise((resolve) => setTimeout(resolve, RENDER_WAIT_MS));
        }
      }

      const evaluated = await send(
        "Runtime.evaluate",
        {
          expression:
            "({ html: (document.doctype ? '<!doctype html>\\n' : '') + document.documentElement.outerHTML, url: location.href })",
          returnByValue: true
        },
        sessionId
      );
      const value = evaluated?.result?.value as { html?: unknown; url?: unknown } | undefined;
      const html = typeof value?.html === "string" ? value.html : "";
      const finalUrl = typeof value?.url === "string" ? value.url : url;
      if (emptyHtml(html)) {
        throw new FetchPageError("Browser renderer returned an empty document.", "empty_dom", expand ? "rendered_with_expansion" : "rendered");
      }
      await assertPublicFetchUrl(normalizeUserUrl(finalUrl));
      return {
        html,
        finalUrl,
        rendered: true,
        fetchMode: expand ? "rendered_with_expansion" : "rendered"
      };
    } finally {
      if (targetId) {
        await send("Target.closeTarget", { targetId }).catch(() => undefined);
      }
      socket.close();
    }
  }, RENDER_TIMEOUT_MS);
}

async function fetchRenderedHtml(url: string, mode: Exclude<FetchMode, "static">): Promise<FetchPageResult | null> {
  try {
    if (mode === "rendered_with_expansion") {
      return await fetchRenderedWithCdp(url, true);
    }

    const content = await fetchRenderedContentHtml(url);
    if (content) {
      return content;
    }

    return await fetchRenderedWithCdp(url, false);
  } catch (error) {
    throw renderError(error, mode);
  }
}

export function fetchErrorCode(error: unknown): FetchErrorCode {
  if (error instanceof FetchPageError) {
    return error.code;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "timeout";
  }
  return "unknown";
}

export async function fetchPage(
  url: string,
  options: { mode?: FetchMode | "auto" } = {}
): Promise<FetchPageResult> {
  normalizeUserUrl(url);
  const mode = options.mode ?? "auto";

  if (mode === "static") {
    return fetchStaticHtml(url);
  }

  if (mode === "rendered" || mode === "rendered_with_expansion") {
    const rendered = await fetchRenderedHtml(url, mode);
    if (!rendered) {
      throw new FetchPageError("Browser renderer is not configured.", "render_unavailable", mode);
    }
    return rendered;
  }

  const staticResult = await fetchStaticHtml(url);
  if (!looksLikeSpaShell(staticResult.html)) {
    return staticResult;
  }

  const rendered = await fetchRenderedHtml(staticResult.finalUrl, "rendered");
  return rendered ?? staticResult;
}
