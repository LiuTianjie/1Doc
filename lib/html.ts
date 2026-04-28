import * as parse5 from "parse5";
import { absoluteUrl, isSameSite, proxiedUrl } from "./url";
import { translateTexts } from "./translate";
import { isMirrorablePage, mirrorHref } from "./mirror/url";
import { extractDocPage } from "./docir/extract";
import { translateExtractedDocPage, type DocTranslationStats } from "./docir/translate";

type TextPatch = {
  node: { value: string };
  source: string;
  prefix: string;
  suffix: string;
};

const SKIP_TEXT_TAGS = new Set([
  "script",
  "style",
  "code",
  "pre",
  "kbd",
  "samp",
  "svg",
  "textarea",
  "input",
  "select",
  "option"
]);

const URL_ATTRS = new Set(["src", "poster"]);
const ABSOLUTE_ONLY_ATTRS = new Set(["href", "action"]);

type LinkMapper = (href: URL, base: URL) => string;

function runtimeScript(baseUrl: string, targetLang: string): string {
  return `(() => {
  const targetLang = ${JSON.stringify(targetLang)};
  const sourceUrl = ${JSON.stringify(baseUrl)};
  const sourceOrigin = new URL(sourceUrl).origin;
  const skipTags = new Set(["SCRIPT","STYLE","CODE","PRE","KBD","SAMP","SVG","TEXTAREA","INPUT","SELECT","OPTION"]);
  const cache = new Map();
  const queued = new Map();
  const inflight = new WeakSet();
  let timer = 0;

  function ignoredUrl(value) {
    return !value || value.startsWith("#") || /^(data|mailto|tel|javascript|blob):/i.test(value);
  }

  function proxied(value) {
    const resolved = new URL(value, sourceUrl);
    if (resolved.origin !== sourceOrigin) return resolved.toString();
    return "/view?url=" + encodeURIComponent(resolved.toString()) + "&lang=" + encodeURIComponent(targetLang);
  }

  function rewriteLinks(root) {
    const links = root.querySelectorAll ? root.querySelectorAll("a[href]") : [];
    for (const link of links) {
      const raw = link.getAttribute("href");
      if (ignoredUrl(raw)) continue;
      try {
        const next = proxied(raw);
        if (next.startsWith("/view?")) link.setAttribute("href", next);
      } catch {}
    }
  }

  document.addEventListener("click", (event) => {
    const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!link) return;
    const raw = link.getAttribute("href");
    if (ignoredUrl(raw) || raw.startsWith("/view?")) return;
    try {
      const next = proxied(raw);
      if (next.startsWith("/view?")) {
        event.preventDefault();
        location.href = next;
      }
    } catch {}
  }, true);

  function shouldSkip(node) {
    const parent = node.parentElement;
    if (!parent) return true;
    if (parent.closest("[data-doc-native-ignore]")) return true;
    if (parent.closest("script,style,code,pre,kbd,samp,svg,textarea,input,select,option")) return true;
    if (parent.closest("[aria-hidden='true'],[hidden]")) return true;
    if (parent.isContentEditable) return true;
    return skipTags.has(parent.tagName);
  }

  function split(value) {
    const prefix = value.match(/^\\s*/)?.[0] || "";
    const suffix = value.match(/\\s*$/)?.[0] || "";
    const source = value.slice(prefix.length, value.length - suffix.length);
    if (source.length < 2 || !/\\p{L}/u.test(source)) return null;
    return { prefix, source, suffix };
  }

  function collect(root) {
    rewriteLinks(root.nodeType === 1 ? root : document);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (inflight.has(node) || shouldSkip(node)) continue;
      const parts = split(node.nodeValue || "");
      if (!parts) continue;
      if (cache.has(parts.source)) {
        node.nodeValue = parts.prefix + cache.get(parts.source) + parts.suffix;
        continue;
      }
      const list = queued.get(parts.source) || [];
      list.push({ node, prefix: parts.prefix, suffix: parts.suffix });
      queued.set(parts.source, list);
    }
    schedule();
  }

  function nextBatch() {
    const texts = [];
    let chars = 0;
    for (const text of queued.keys()) {
      if (texts.length >= 32 || chars + text.length > 4000) break;
      texts.push(text);
      chars += text.length;
    }
    return texts;
  }

  async function flush() {
    timer = 0;
    const texts = nextBatch();
    if (!texts.length) return;
    const entries = texts.map((text) => [text, queued.get(text) || []]);
    for (const text of texts) {
      const refs = queued.get(text) || [];
      queued.delete(text);
      for (const ref of refs) inflight.add(ref.node);
    }
    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetLang, texts })
      });
      const payload = await response.json();
      const translations = Array.isArray(payload.translations) ? payload.translations : texts;
      entries.forEach(([source, refs], index) => {
        const translated = typeof translations[index] === "string" ? translations[index] : source;
        cache.set(source, translated);
        refs.forEach((ref) => {
          if (ref.node.isConnected) ref.node.nodeValue = ref.prefix + translated + ref.suffix;
          inflight.delete(ref.node);
        });
      });
    } catch {
      entries.forEach(([source, refs]) => refs.forEach((ref) => {
        if (ref.node.isConnected) ref.node.nodeValue = ref.prefix + source + ref.suffix;
        inflight.delete(ref.node);
      }));
    } finally {
      if (queued.size) schedule();
    }
  }

  function schedule() {
    if (!timer) timer = window.setTimeout(flush, 120);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") collect(mutation.target.parentNode || document.body);
      mutation.addedNodes.forEach((node) => collect(node));
    }
  });

  function start() {
    collect(document.body || document.documentElement);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();`;
}

function getAttrs(node: any): Array<{ name: string; value: string }> {
  return Array.isArray(node.attrs) ? node.attrs : [];
}

function getAttr(node: any, name: string): string | null {
  return getAttrs(node).find((attr) => attr.name.toLowerCase() === name)?.value ?? null;
}

function setAttr(node: any, name: string, value: string): void {
  const existing = getAttrs(node).find((attr) => attr.name.toLowerCase() === name);
  if (existing) {
    existing.value = value;
  } else {
    node.attrs = [...getAttrs(node), { name, value }];
  }
}

function shouldDropNode(node: any): boolean {
  if (node.tagName !== "meta") {
    return false;
  }

  return getAttr(node, "http-equiv")?.toLowerCase() === "content-security-policy";
}

function shouldSkipElementText(node: any): boolean {
  if (!node.tagName) {
    return false;
  }

  if (SKIP_TEXT_TAGS.has(node.tagName)) {
    return true;
  }

  if (getAttr(node, "aria-hidden") === "true" || getAttr(node, "hidden") !== null) {
    return true;
  }

  const style = getAttr(node, "style")?.toLowerCase() ?? "";
  return style.includes("display:none") || style.includes("visibility:hidden");
}

function hasTranslatableLetters(value: string): boolean {
  return /\p{L}/u.test(value);
}

function splitTextValue(value: string): { prefix: string; source: string; suffix: string } | null {
  const prefix = value.match(/^\s*/)?.[0] ?? "";
  const suffix = value.match(/\s*$/)?.[0] ?? "";
  const source = value.slice(prefix.length, value.length - suffix.length);

  if (source.length < 2 || !hasTranslatableLetters(source)) {
    return null;
  }

  return { prefix, source, suffix };
}

function safeAbsolute(value: string, baseUrl: string): string {
  try {
    return absoluteUrl(value, baseUrl);
  } catch {
    return value;
  }
}

function shouldIgnoreUrl(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith("#") ||
    /^(data|mailto|tel|javascript|blob):/i.test(trimmed)
  );
}

function rewriteSrcset(value: string, baseUrl: string): string {
  return value
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      const firstSpace = trimmed.search(/\s/);
      const rawUrl = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
      const descriptor = firstSpace === -1 ? "" : trimmed.slice(firstSpace);
      if (shouldIgnoreUrl(rawUrl)) {
        return trimmed;
      }
      return `${safeAbsolute(rawUrl, baseUrl)}${descriptor}`;
    })
    .join(", ");
}

function rewriteCssUrls(value: string, baseUrl: string): string {
  return value.replace(/url\((['"]?)([^'")]+)\1\)/gi, (match, quote: string, rawUrl: string) => {
    if (shouldIgnoreUrl(rawUrl)) {
      return match;
    }

    return `url(${quote}${safeAbsolute(rawUrl, baseUrl)}${quote})`;
  });
}

function rewriteAttributes(
  node: any,
  baseUrl: string,
  targetLang: string,
  proxyPath: string,
  linkMapper?: LinkMapper
): void {
  if (!node.tagName) {
    return;
  }

  const base = new URL(baseUrl);

  for (const attr of getAttrs(node)) {
    const name = attr.name.toLowerCase();
    const value = attr.value;

    if (name === "srcset" && !shouldIgnoreUrl(value)) {
      attr.value = rewriteSrcset(value, baseUrl);
      continue;
    }

    if (name === "style") {
      attr.value = rewriteCssUrls(value, baseUrl);
      continue;
    }

    if (!URL_ATTRS.has(name) && !ABSOLUTE_ONLY_ATTRS.has(name)) {
      continue;
    }

    if (shouldIgnoreUrl(value)) {
      continue;
    }

    const absolute = safeAbsolute(value, baseUrl);
    if (node.tagName === "a" && name === "href") {
      try {
        const href = new URL(absolute);
        attr.value = linkMapper
          ? linkMapper(href, base)
          : isSameSite(href, base)
            ? proxiedUrl(href.toString(), targetLang, proxyPath)
            : href.toString();
        if (!isSameSite(href, base) || attr.value === href.toString()) {
          setAttr(node, "target", "_blank");
          setAttr(node, "rel", "noreferrer");
        }
      } catch {
        attr.value = absolute;
      }
      continue;
    }

    attr.value = absolute;
  }
}

function collectTextPatches(node: any, patches: TextPatch[], skipText: boolean): void {
  if (shouldDropNode(node)) {
    return;
  }

  const nextSkip = skipText || shouldSkipElementText(node);
  rewriteStyleNode(node);
  if (node.nodeName === "#text" && !nextSkip) {
    const split = splitTextValue(node.value ?? "");
    if (split) {
      patches.push({ node, ...split });
    }
    return;
  }

  if (!Array.isArray(node.childNodes)) {
    return;
  }

  node.childNodes = node.childNodes.filter((child: any) => !shouldDropNode(child));
  for (const child of node.childNodes) {
    collectTextPatches(child, patches, nextSkip);
  }
}

function rewriteStyleNode(node: any): void {
  if (node.tagName !== "style" || !Array.isArray(node.childNodes)) {
    return;
  }

  for (const child of node.childNodes) {
    if (child.nodeName === "#text") {
      child.value = rewriteCssUrls(child.value ?? "", node.__docNativeBaseUrl);
    }
  }
}

function rewriteTree(
  node: any,
  baseUrl: string,
  targetLang: string,
  proxyPath = "/view",
  linkMapper?: LinkMapper
): void {
  node.__docNativeBaseUrl = baseUrl;
  rewriteAttributes(node, baseUrl, targetLang, proxyPath, linkMapper);

  if (!Array.isArray(node.childNodes)) {
    return;
  }

  node.childNodes = node.childNodes.filter((child: any) => !shouldDropNode(child));
  for (const child of node.childNodes) {
    rewriteTree(child, baseUrl, targetLang, proxyPath, linkMapper);
  }
}

function shouldDropForSnapshot(node: any): boolean {
  if (node.tagName === "base") {
    return true;
  }

  if (node.tagName === "script" || node.tagName === "noscript") {
    return true;
  }

  if (node.tagName === "link") {
    const rel = getAttr(node, "rel")?.toLowerCase() ?? "";
    const as = getAttr(node, "as")?.toLowerCase() ?? "";
    return rel === "modulepreload" || (rel === "preload" && as === "script");
  }

  return shouldDropNode(node);
}

function stripSnapshotRuntime(node: any): void {
  if (!Array.isArray(node.childNodes)) {
    return;
  }

  node.childNodes = node.childNodes.filter((child: any) => !shouldDropForSnapshot(child));
  for (const child of node.childNodes) {
    stripSnapshotRuntime(child);
  }
}

export async function translateHtml(html: string, baseUrl: string, targetLang: string): Promise<string> {
  const document = parse5.parse(html);
  rewriteTree(document, baseUrl, targetLang);

  const patches: TextPatch[] = [];
  collectTextPatches(document, patches, false);
  const translations = await translateTexts(
    patches.map((patch) => patch.source),
    targetLang
  );

  for (const patch of patches) {
    const translated = translations.get(patch.source) ?? patch.source;
    patch.node.value = `${patch.prefix}${translated}${patch.suffix}`;
  }

  return parse5.serialize(document);
}

export async function translateSnapshotHtml(html: string, baseUrl: string, targetLang: string): Promise<string> {
  const document = parse5.parse(html);
  rewriteTree(document, baseUrl, targetLang, "/snapshot");
  stripSnapshotRuntime(document);

  const patches: TextPatch[] = [];
  collectTextPatches(document, patches, false);
  const translations = await translateTexts(
    patches.map((patch) => patch.source),
    targetLang
  );

  for (const patch of patches) {
    const translated = translations.get(patch.source) ?? patch.source;
    patch.node.value = `${patch.prefix}${translated}${patch.suffix}`;
  }

  return parse5.serialize(document);
}

export async function translateMirrorHtml(
  html: string,
  baseUrl: string,
  targetLang: string,
  siteSlug: string,
  rootUrl: string,
  scopePath = "/"
): Promise<string> {
  return (await translateMirrorHtmlWithStats(html, baseUrl, targetLang, siteSlug, rootUrl, scopePath)).html;
}

export async function translateMirrorHtmlWithStats(
  html: string,
  baseUrl: string,
  targetLang: string,
  siteSlug: string,
  rootUrl: string,
  scopePath = "/"
): Promise<{ html: string; stats: DocTranslationStats }> {
  const document = parse5.parse(html);
  rewriteTree(document, baseUrl, targetLang, "/sites", (href) => {
    if (!isMirrorablePage(href.toString(), rootUrl, scopePath)) {
      return href.toString();
    }

    return mirrorHref(siteSlug, targetLang, href.toString(), href.hash);
  });
  stripSnapshotRuntime(document);

  const docPage = extractDocPage(document);
  const stats = await translateExtractedDocPage(docPage, targetLang);

  return { html: parse5.serialize(document), stats };
}

function findElement(node: any, tagName: string): any | null {
  if (node.tagName === tagName) {
    return node;
  }

  if (!Array.isArray(node.childNodes)) {
    return null;
  }

  for (const child of node.childNodes) {
    const found = findElement(child, tagName);
    if (found) {
      return found;
    }
  }

  return null;
}

function appendInlineScript(document: any, scriptContent: string): void {
  const target = findElement(document, "body") ?? findElement(document, "html") ?? document;
  target.childNodes = target.childNodes ?? [];
  const safeScript = scriptContent.replace(/<\/script/gi, "<\\/script");
  const fragment = parse5.parseFragment(`<script data-doc-native-ignore="true">${safeScript}</script>`) as any;
  target.childNodes.push(...(fragment.childNodes ?? []));
}

export function prepareHtmlForProxy(html: string, baseUrl: string, targetLang: string): string {
  const document = parse5.parse(html);
  rewriteTree(document, baseUrl, targetLang);
  appendInlineScript(document, runtimeScript(baseUrl, targetLang));
  return parse5.serialize(document);
}
