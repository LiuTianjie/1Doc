import * as parse5 from "parse5";
import { completeJsonWithArk } from "../ark";
import {
  getDocSiteById,
  getSiteLlmText,
  listMirroredPagesWithHtml,
  listSourcePages,
  releaseSiteLlmTextLock,
  tryClaimSiteLlmTextLock,
  upsertSiteLlmText
} from "./store";
import type { MirroredPage, SiteLlmText, SourcePage } from "./types";

type RawBlock = {
  type: "heading" | "text";
  text: string;
};

type PageSignal = {
  path: string;
  url: string;
  title: string;
  headings: string[];
  excerpt: string;
  keywords: string[];
};

type KnowledgeSection = {
  name: string;
  description: string;
  pages: string[];
};

type KnowledgeTopic = {
  name: string;
  sections: KnowledgeSection[];
};

type SemanticLayer = {
  description: string;
  knowledgeStructure: KnowledgeTopic[];
  pageSummaries: Map<string, { title: string; summary: string }>;
  keyConcepts: string[];
  usageHints: string[];
};

const SKIP_TAGS = new Set([
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
const BLOCK_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "td", "th", "blockquote", "summary", "dt", "dd"]);
const DEFAULT_LLM_TEXT_MODEL = "doubao-seed-2-0-lite-260215";
const DEFAULT_LLM_TEXT_TIMEOUT_MS = 90000;
const DEFAULT_LLM_TEXT_MAX_PAGES = 80;
const DEFAULT_LLM_TEXT_MAX_CHARS = 60000;
const MAX_HEADINGS_PER_PAGE = 8;
const MAX_KEYWORDS_PER_PAGE = 8;
const MAX_CONCEPTS = 24;
const MAX_HINTS = 10;
const LLM_TEXT_FORMAT = "1doc-llm-text-v2";
const DEFAULT_LLM_TEXT_WAIT_MS = 120000;
const LLM_TEXT_WAIT_INTERVAL_MS = 1500;

const globalForLlmText = globalThis as typeof globalThis & {
  __docNativeLlmTextGeneration?: Map<string, Promise<SiteLlmText>>;
};
const inflightGenerations =
  globalForLlmText.__docNativeLlmTextGeneration ??
  (globalForLlmText.__docNativeLlmTextGeneration = new Map<string, Promise<SiteLlmText>>());

export function isEnrichedSiteLlmText(content: string): boolean {
  return (
    content.includes(`Format: ${LLM_TEXT_FORMAT}`) ||
    (content.includes("# SITE OVERVIEW") &&
      content.includes("# KNOWLEDGE STRUCTURE") &&
      content.includes("# PAGE SUMMARIES") &&
      content.includes("# KEY CONCEPTS") &&
      content.includes("# USAGE HINTS"))
  );
}

function siteBaseUrl(): string {
  return (process.env.SITE_BASE_URL || "").replace(/\/$/, "");
}

function absoluteMirrorUrl(siteSlug: string, lang: string, path: string): string {
  const relative = `/sites/${siteSlug}/${lang}${path}`;
  const baseUrl = siteBaseUrl();
  return baseUrl ? `${baseUrl}${relative}` : relative;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function markdownText(value: string): string {
  return normalizeText(value).replace(/([\\[\]()])/g, "\\$1");
}

function truncateText(value: string, maxLength: number): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generationKey(siteId: string, lang: string): string {
  return `${siteId}:${lang}`;
}

function getAttrs(node: any): Array<{ name: string; value: string }> {
  return Array.isArray(node.attrs) ? node.attrs : [];
}

function getAttr(node: any, name: string): string | null {
  return getAttrs(node).find((attr) => attr.name.toLowerCase() === name)?.value ?? null;
}

function className(node: any): string {
  return getAttr(node, "class")?.toLowerCase() ?? "";
}

function walk(node: any, visit: (node: any) => void): void {
  visit(node);
  if (!Array.isArray(node.childNodes)) {
    return;
  }
  for (const child of node.childNodes) {
    walk(child, visit);
  }
}

function findElement(node: any, predicate: (node: any) => boolean): any | null {
  if (predicate(node)) {
    return node;
  }
  if (!Array.isArray(node.childNodes)) {
    return null;
  }
  for (const child of node.childNodes) {
    const found = findElement(child, predicate);
    if (found) {
      return found;
    }
  }
  return null;
}

function shouldSkipElement(node: any): boolean {
  if (!node.tagName) {
    return false;
  }
  if (SKIP_TAGS.has(node.tagName)) {
    return true;
  }
  if (getAttr(node, "aria-hidden") === "true" || getAttr(node, "hidden") !== null) {
    return true;
  }
  const style = getAttr(node, "style")?.toLowerCase() ?? "";
  return style.includes("display:none") || style.includes("visibility:hidden");
}

function textContent(node: any, skip = false): string {
  const nextSkip = skip || shouldSkipElement(node);
  if (node.nodeName === "#text" && !nextSkip) {
    return node.value ?? "";
  }
  if (!Array.isArray(node.childNodes)) {
    return "";
  }
  return node.childNodes.map((child: any) => textContent(child, nextSkip)).join("");
}

function titleFromDocument(document: any): string | null {
  const title = findElement(document, (node) => node.tagName === "title");
  const text = title ? normalizeText(textContent(title)) : "";
  return text || null;
}

function scoreContentRoot(node: any): number {
  if (!node.tagName) {
    return 0;
  }

  const cls = className(node);
  const id = getAttr(node, "id")?.toLowerCase() ?? "";
  const role = getAttr(node, "role")?.toLowerCase() ?? "";
  let score = textContent(node).length;

  if (node.tagName === "main") score += 9000;
  if (node.tagName === "article") score += 8500;
  if (role === "main") score += 8000;
  if (cls.includes("theme-doc-markdown")) score += 9500;
  if (cls.includes("vp-doc")) score += 9500;
  if (cls.includes("markdown")) score += 2500;
  if (cls.includes("doc") || id.includes("doc")) score += 1200;
  if (cls.includes("sidebar") || cls.includes("navbar") || cls.includes("footer")) score -= 10000;

  return score;
}

function findContentRoot(document: any): any {
  const candidates: any[] = [];
  walk(document, (node) => {
    if (node.tagName) {
      candidates.push(node);
    }
  });

  const best = candidates
    .map((node) => ({ node, score: scoreContentRoot(node) }))
    .sort((a, b) => b.score - a.score)[0];

  if (best && best.score > 1500) {
    return best.node;
  }
  return findElement(document, (node) => node.tagName === "body") ?? document;
}

function collectBlocks(root: any): RawBlock[] {
  const blocks: RawBlock[] = [];

  function visit(node: any): void {
    if (shouldSkipElement(node)) {
      return;
    }

    if (node.tagName && BLOCK_TAGS.has(node.tagName)) {
      const text = normalizeText(textContent(node));
      if (text.length > 1 && /\p{L}/u.test(text)) {
        blocks.push({
          type: /^h[1-6]$/.test(node.tagName) ? "heading" : "text",
          text
        });
      }
      return;
    }

    if (!Array.isArray(node.childNodes)) {
      return;
    }
    for (const child of node.childNodes) {
      visit(child);
    }
  }

  visit(root);
  return blocks;
}

function uniqueStrings(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function pathSegments(path: string): string[] {
  return path
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .map((segment) => segment.replace(/[-_]+/g, " ").trim())
    .filter(Boolean);
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.startsWith("$") ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`))
    .join(" ");
}

function readablePathPart(value: string, fallback: string): string {
  const text = titleCase(value.replace(/[-_]+/g, " ").trim());
  return text || fallback;
}

function firstSentence(value: string): string {
  const match = normalizeText(value).match(/^(.{30,220}?[。！？.!?])\s/);
  return truncateText(match?.[1] ?? value, 220);
}

function keywordCandidates(path: string, title: string, headings: string[]): string[] {
  const candidates: string[] = [...pathSegments(path), title, ...headings];
  for (const heading of headings) {
    candidates.push(...(heading.match(/\$?[A-Za-z][A-Za-z0-9_$.-]{2,}/g) ?? []));
  }
  return uniqueStrings(
    candidates
      .map((item) => item.replace(/[()[\]{}:：,，.。]+$/g, ""))
      .filter((item) => item.length >= 2 && item.length <= 48),
    MAX_KEYWORDS_PER_PAGE
  );
}

function localSummaryFor(page: PageSignal): string {
  if (page.excerpt) {
    return firstSentence(page.excerpt);
  }
  if (page.headings.length) {
    return truncateText(page.headings.slice(0, 4).join("；"), 220);
  }
  return `${page.title} related documentation.`;
}

function pageTitleFor(sourceTitle: string | null, documentTitle: string | null, headings: string[], path: string): string {
  const source = normalizeText(sourceTitle || "");
  const document = normalizeText(documentTitle || "");
  return document || source || headings[0] || path || "/";
}

function extractPageSignal(page: MirroredPage, source: SourcePage | undefined, siteSlug: string, lang: string): PageSignal {
  const document = parse5.parse(page.html);
  const root = findContentRoot(document);
  const blocks = collectBlocks(root);
  const headings = uniqueStrings(blocks.filter((block) => block.type === "heading").map((block) => block.text), MAX_HEADINGS_PER_PAGE);
  const bodyText = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .filter((text) => text.length >= 12)
    .join(" ");
  const title = pageTitleFor(source?.title ?? null, titleFromDocument(document), headings, page.path);

  return {
    path: page.path,
    url: absoluteMirrorUrl(siteSlug, lang, page.path),
    title,
    headings,
    excerpt: truncateText(bodyText, 700),
    keywords: keywordCandidates(page.path, title, headings)
  };
}

function localDescription(siteName: string, lang: string, pages: PageSignal[]): string {
  const concepts = localKeyConcepts(pages).slice(0, 8).join(", ");
  return concepts
    ? `${siteName} documentation mirror in ${lang}, covering ${concepts}.`
    : `${siteName} documentation mirror in ${lang}.`;
}

function localKnowledgeStructure(pages: PageSignal[]): KnowledgeTopic[] {
  const topics = new Map<string, Map<string, PageSignal[]>>();

  for (const page of pages) {
    const segments = pathSegments(page.path);
    const topicName = readablePathPart(segments[0] || "Overview", "Overview");
    const sectionName = readablePathPart(segments[1] || page.headings[0] || page.title, page.title);
    const sections = topics.get(topicName) ?? new Map<string, PageSignal[]>();
    sections.set(sectionName, [...(sections.get(sectionName) ?? []), page]);
    topics.set(topicName, sections);
  }

  return [...topics.entries()].map(([name, sections]) => ({
    name,
    sections: [...sections.entries()].map(([sectionName, sectionPages]) => {
      const terms = uniqueStrings(sectionPages.flatMap((page) => [page.title, ...page.headings, ...page.keywords]), 5);
      return {
        name: sectionName,
        description: terms.length ? `Covers ${terms.join(", ")}.` : `${sectionName} related documentation.`,
        pages: sectionPages.map((page) => page.path)
      };
    })
  }));
}

function localKeyConcepts(pages: PageSignal[]): string[] {
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const keyword of pages.flatMap((page) => page.keywords)) {
    const key = keyword.toLowerCase();
    if (!labels.has(key)) {
      labels.set(key, keyword);
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([keyword]) => labels.get(keyword) ?? keyword)
    .slice(0, MAX_CONCEPTS);
}

function localUsageHints(topics: KnowledgeTopic[], pageSummaries: Map<string, { title: string; summary: string }>): string[] {
  const hints: string[] = [];
  for (const topic of topics.slice(0, 5)) {
    const firstPage = topic.sections.flatMap((section) => section.pages)[0];
    if (firstPage) {
      hints.push(`When a question is about ${topic.name}, start with ${firstPage}.`);
    }
  }
  for (const [path, summary] of pageSummaries) {
    if (hints.length >= MAX_HINTS) {
      break;
    }
    hints.push(`Use ${path} for questions related to ${summary.title}.`);
  }
  return uniqueStrings(hints, MAX_HINTS);
}

function promptPages(pages: PageSignal[]): Array<Omit<PageSignal, "url"> & { url: string }> {
  const maxPages = envInt("LLM_TEXT_MAX_PAGES", DEFAULT_LLM_TEXT_MAX_PAGES, 1, 500);
  const maxChars = envInt("LLM_TEXT_MAX_CHARS", DEFAULT_LLM_TEXT_MAX_CHARS, 4000, 200000);
  const selected: Array<Omit<PageSignal, "url"> & { url: string }> = [];
  let chars = 0;

  for (const page of pages) {
    const compact = {
      path: page.path,
      url: page.url,
      title: truncateText(page.title, 120),
      headings: page.headings.slice(0, 6).map((heading) => truncateText(heading, 120)),
      excerpt: truncateText(page.excerpt, 420),
      keywords: page.keywords
    };
    const size = JSON.stringify(compact).length;
    if (selected.length >= maxPages || (selected.length > 0 && chars + size > maxChars)) {
      break;
    }
    selected.push(compact);
    chars += size;
  }
  return selected;
}

function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.filter((item): item is string => typeof item === "string"), limit);
}

function cleanPageList(value: unknown, allowedPaths: Set<string>): string[] {
  return stringList(value, 1000).filter((path) => allowedPaths.has(path));
}

function semanticFromRaw(raw: unknown, local: SemanticLayer, pages: PageSignal[]): SemanticLayer {
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const allowedPaths = new Set(pages.map((page) => page.path));
  const pageTitles = new Map(pages.map((page) => [page.path, page.title]));
  const pageSummaries = new Map(local.pageSummaries);

  if (Array.isArray(data.pageSummaries)) {
    for (const item of data.pageSummaries) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      const path = typeof record.path === "string" ? record.path : "";
      if (!allowedPaths.has(path)) {
        continue;
      }
      const title = typeof record.title === "string" && record.title.trim() ? record.title : pageTitles.get(path) ?? path;
      const summary = typeof record.summary === "string" && record.summary.trim() ? record.summary : pageSummaries.get(path)?.summary ?? "";
      pageSummaries.set(path, {
        title: truncateText(title, 140),
        summary: truncateText(summary, 260)
      });
    }
  }

  const knowledgeStructure: KnowledgeTopic[] = [];
  if (Array.isArray(data.knowledgeStructure)) {
    for (const topicValue of data.knowledgeStructure) {
      if (!topicValue || typeof topicValue !== "object") {
        continue;
      }
      const topic = topicValue as Record<string, unknown>;
      const name = typeof topic.name === "string" ? truncateText(topic.name, 80) : "";
      const sections: KnowledgeSection[] = [];
      if (Array.isArray(topic.sections)) {
        for (const sectionValue of topic.sections) {
          if (!sectionValue || typeof sectionValue !== "object") {
            continue;
          }
          const section = sectionValue as Record<string, unknown>;
          const sectionName = typeof section.name === "string" ? truncateText(section.name, 80) : "";
          const pagesForSection = cleanPageList(section.pages, allowedPaths);
          if (!sectionName || pagesForSection.length === 0) {
            continue;
          }
          const description = typeof section.description === "string" && section.description.trim()
            ? truncateText(section.description, 220)
            : `${sectionName} related documentation.`;
          sections.push({ name: sectionName, description, pages: pagesForSection });
        }
      }
      if (name && sections.length > 0) {
        knowledgeStructure.push({ name, sections });
      }
    }
  }

  const description = typeof data.description === "string" && data.description.trim()
    ? truncateText(data.description, 500)
    : local.description;
  const keyConcepts = stringList(data.keyConcepts, MAX_CONCEPTS);
  const usageHints = stringList(data.usageHints, MAX_HINTS);

  return {
    description,
    knowledgeStructure: knowledgeStructure.length ? knowledgeStructure : local.knowledgeStructure,
    pageSummaries,
    keyConcepts: keyConcepts.length ? keyConcepts : local.keyConcepts,
    usageHints: usageHints.length ? usageHints : local.usageHints
  };
}

async function generateSemanticLayer(siteName: string, sourceUrl: string, lang: string, pages: PageSignal[]): Promise<SemanticLayer> {
  const localPageSummaries = new Map(pages.map((page) => [
    page.path,
    {
      title: page.title,
      summary: localSummaryFor(page)
    }
  ]));
  const localTopics = localKnowledgeStructure(pages);
  const local: SemanticLayer = {
    description: localDescription(siteName, lang, pages),
    knowledgeStructure: localTopics,
    pageSummaries: localPageSummaries,
    keyConcepts: localKeyConcepts(pages),
    usageHints: localUsageHints(localTopics, localPageSummaries)
  };

  if (!process.env.ARK_API_KEY) {
    return local;
  }

  try {
    const raw = await completeJsonWithArk({
      model: process.env.LLM_TEXT_MODEL || DEFAULT_LLM_TEXT_MODEL,
      timeoutMs: envInt("LLM_TEXT_TIMEOUT_MS", DEFAULT_LLM_TEXT_TIMEOUT_MS, 1000, 300000),
      errorPrefix: "Ark LLM.txt generation",
      system:
        "You generate structured documentation indexes for retrieval-augmented LLM use. Return only valid JSON. Do not invent pages. Use the same language as the target documentation for descriptions, summaries, concepts, and hints.",
      user: {
        task: "Create an enriched LLM.txt semantic layer from these generated documentation pages.",
        outputShape: {
          description: "short site description",
          knowledgeStructure: [
            {
              name: "major product or topic",
              sections: [
                {
                  name: "subtopic",
                  description: "what this subtopic covers",
                  pages: ["/exact-page-path"]
                }
              ]
            }
          ],
          pageSummaries: [
            {
              path: "/exact-page-path",
              title: "page title",
              summary: "one sentence summary"
            }
          ],
          keyConcepts: ["searchable concept"],
          usageHints: ["When the user asks about X, prefer /path."]
        },
        constraints: [
          "Use only page paths from the input.",
          "Prefer concrete product concepts over generic words.",
          "Keep summaries concise.",
          "Group related pages semantically, not only alphabetically."
        ],
        site: {
          name: siteName,
          sourceUrl,
          language: lang,
          pageCount: pages.length
        },
        pages: promptPages(pages)
      }
    });
    return semanticFromRaw(raw, local, pages);
  } catch (error) {
    console.warn("LLM.txt semantic generation failed; falling back to local extraction.", error);
    return local;
  }
}

function renderKnowledgeStructure(topics: KnowledgeTopic[]): string[] {
  const lines: string[] = ["# KNOWLEDGE STRUCTURE", ""];
  for (const topic of topics) {
    lines.push(`## ${markdownText(topic.name)}`);
    for (const section of topic.sections) {
      lines.push(`- ${markdownText(section.name)}`);
      lines.push(`  描述：${markdownText(section.description)}`);
      lines.push("  pages:");
      for (const path of section.pages) {
        lines.push(`    - ${path}`);
      }
      lines.push("");
    }
    if (lines[lines.length - 1] !== "") {
      lines.push("");
    }
  }
  return lines;
}

function renderLlmText(siteName: string, sourceUrl: string, lang: string, pages: PageSignal[], semantic: SemanticLayer): string {
  const lines = [
    "# SITE OVERVIEW",
    `Name: ${siteName}`,
    `Format: ${LLM_TEXT_FORMAT}`,
    `Source: ${sourceUrl}`,
    `Language: ${lang}`,
    `Pages: ${pages.length}`,
    "",
    "## Description",
    semantic.description,
    "",
    "---",
    "",
    ...renderKnowledgeStructure(semantic.knowledgeStructure),
    "---",
    "",
    "# PAGE SUMMARIES",
    ""
  ];

  for (const page of pages) {
    const summary = semantic.pageSummaries.get(page.path) ?? { title: page.title, summary: localSummaryFor(page) };
    lines.push(`## ${page.path}`);
    lines.push(`标题：${markdownText(summary.title)}`);
    lines.push(`摘要：${markdownText(summary.summary)}`);
    lines.push(`链接：${page.url}`);
    lines.push("");
  }

  lines.push("---", "", "# KEY CONCEPTS", "");
  for (const concept of semantic.keyConcepts) {
    lines.push(`- ${markdownText(concept)}`);
  }

  lines.push("", "---", "", "# USAGE HINTS (给LLM的提示)", "");
  for (const hint of semantic.usageHints) {
    lines.push(`- ${markdownText(hint)}`);
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

async function waitForGeneratedSiteLlmText(siteId: string, lang: string): Promise<SiteLlmText | null> {
  const timeoutMs = envInt("LLM_TEXT_WAIT_MS", DEFAULT_LLM_TEXT_WAIT_MS, 1000, 300000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(LLM_TEXT_WAIT_INTERVAL_MS);
    const llmText = await getSiteLlmText(siteId, lang);
    if (llmText && isEnrichedSiteLlmText(llmText.content)) {
      return llmText;
    }
  }

  return null;
}

async function generateSiteLlmTextUnlocked(siteId: string, lang: string): Promise<SiteLlmText> {
  const site = await getDocSiteById(siteId);
  if (!site) {
    throw new Error(`Site ${siteId} was not found.`);
  }

  const [sourcePages, mirroredPages] = await Promise.all([listSourcePages(site.id), listMirroredPagesWithHtml(site.id, lang)]);
  const sourcesByPath = new Map(sourcePages.map((page) => [page.path, page]));
  const pages = mirroredPages
    .map((page) => extractPageSignal(page, sourcesByPath.get(page.path), site.slug, lang));

  if (pages.length === 0) {
    throw new Error(`No generated pages are available for ${lang}.`);
  }

  const siteName = site.title?.trim() || new URL(site.entry_url).hostname.replace(/^www\./, "");
  const semantic = await generateSemanticLayer(siteName, site.entry_url, lang, pages);
  const content = renderLlmText(siteName, site.entry_url, lang, pages, semantic);

  return upsertSiteLlmText({
    site_id: site.id,
    lang,
    content,
    page_count: pages.length
  });
}

async function generateSiteLlmTextWithLock(siteId: string, lang: string): Promise<SiteLlmText> {
  const claimed = await tryClaimSiteLlmTextLock(siteId, lang);
  if (!claimed) {
    const generated = await waitForGeneratedSiteLlmText(siteId, lang);
    if (generated) {
      return generated;
    }
    throw new Error(`LLM.txt generation is already running for ${lang}. Please try again shortly.`);
  }

  try {
    return await generateSiteLlmTextUnlocked(siteId, lang);
  } finally {
    await releaseSiteLlmTextLock(siteId, lang);
  }
}

export async function generateSiteLlmText(siteId: string, lang: string): Promise<SiteLlmText> {
  const normalizedLang = lang.trim().toLowerCase();
  const cached = await getSiteLlmText(siteId, normalizedLang);
  if (cached && isEnrichedSiteLlmText(cached.content)) {
    return cached;
  }

  const key = generationKey(siteId, normalizedLang);
  const existing = inflightGenerations.get(key);
  if (existing) {
    return existing;
  }

  const generation = generateSiteLlmTextWithLock(siteId, normalizedLang);
  inflightGenerations.set(key, generation);
  try {
    return await generation;
  } finally {
    if (inflightGenerations.get(key) === generation) {
      inflightGenerations.delete(key);
    }
  }
}

export async function generateSiteLlmTexts(siteId: string, langs?: string[]): Promise<SiteLlmText[]> {
  const site = await getDocSiteById(siteId);
  if (!site) {
    throw new Error(`Site ${siteId} was not found.`);
  }

  const targetLangs = langs?.length ? langs : site.target_langs;
  const results: SiteLlmText[] = [];
  for (const lang of targetLangs) {
    results.push(await generateSiteLlmText(site.id, lang));
  }
  return results;
}
