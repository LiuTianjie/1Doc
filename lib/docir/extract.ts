import type { DocBlockType, DocTextPatch, ExtractedDocPage } from "./types";
import { protectText } from "./protect";

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

const BLOCK_TAGS: Record<string, DocBlockType> = {
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  p: "paragraph",
  li: "listItem",
  td: "tableCell",
  th: "tableCell",
  blockquote: "blockquote",
  summary: "paragraph",
  dt: "description",
  dd: "description",
  figcaption: "caption"
};

function getAttrs(node: any): Array<{ name: string; value: string }> {
  return Array.isArray(node.attrs) ? node.attrs : [];
}

function getAttr(node: any, name: string): string | null {
  return getAttrs(node).find((attr) => attr.name.toLowerCase() === name)?.value ?? null;
}

function className(node: any): string {
  return getAttr(node, "class")?.toLowerCase() ?? "";
}

function titleFromDocument(document: any): string | null {
  const title = findElement(document, (node) => node.tagName === "title");
  const text = title ? textContent(title).trim() : "";
  return text || null;
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

function findContentRoot(document: any): { node: any; rootFound: boolean } {
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
    return { node: best.node, rootFound: true };
  }

  return { node: findElement(document, (node) => node.tagName === "body") ?? document, rootFound: false };
}

function textContent(node: any): string {
  if (node.nodeName === "#text") {
    return node.value ?? "";
  }

  if (!Array.isArray(node.childNodes)) {
    return "";
  }

  return node.childNodes.map(textContent).join("");
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

function hasLetters(value: string): boolean {
  return /\p{L}/u.test(value);
}

function splitTextValue(value: string): { prefix: string; source: string; suffix: string } | null {
  const prefix = value.match(/^\s*/)?.[0] ?? "";
  const suffix = value.match(/\s*$/)?.[0] ?? "";
  const source = value.slice(prefix.length, value.length - suffix.length);

  if (source.length < 2 || !hasLetters(source)) {
    return null;
  }

  return { prefix, source, suffix };
}

function blockTypeFor(node: any): DocBlockType | null {
  if (!node.tagName) {
    return null;
  }

  const cls = className(node);
  if (cls.includes("admonition") || cls.includes("callout") || cls.includes("alert")) {
    return "callout";
  }

  return BLOCK_TAGS[node.tagName] ?? null;
}

function hasBlockChild(node: any): boolean {
  if (!Array.isArray(node.childNodes)) {
    return false;
  }

  return node.childNodes.some((child: any) => Boolean(blockTypeFor(child)));
}

function collectTextPatches(node: any, patches: DocTextPatch[], skip = false): void {
  const nextSkip = skip || shouldSkipElement(node);

  if (node.nodeName === "#text" && !nextSkip) {
    const split = splitTextValue(node.value ?? "");
    if (split) {
      const protectedText = protectText(split.source);
      patches.push({
        node,
        source: split.source,
        protectedSource: protectedText.text,
        prefix: split.prefix,
        suffix: split.suffix,
        tokens: protectedText.tokens
      });
    }
    return;
  }

  if (!Array.isArray(node.childNodes)) {
    return;
  }

  for (const child of node.childNodes) {
    collectTextPatches(child, patches, nextSkip);
  }
}

function collectBlocks(root: any): { blocks: ExtractedDocPage["blocks"]; patches: DocTextPatch[] } {
  const blocks: ExtractedDocPage["blocks"] = [];
  const patches: DocTextPatch[] = [];
  let blockIndex = 0;

  function visit(node: any): void {
    if (shouldSkipElement(node)) {
      return;
    }

    const type = blockTypeFor(node);
    if (type && (type !== "callout" || !hasBlockChild(node))) {
      const blockPatches: DocTextPatch[] = [];
      collectTextPatches(node, blockPatches);

      if (blockPatches.length > 0) {
        const text = blockPatches.map((patch) => patch.protectedSource).join("\n");
        blocks.push({
          id: `block-${blockIndex}`,
          type,
          text,
          patchCount: blockPatches.length
        });
        blockIndex += 1;
        patches.push(...blockPatches);
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
  return { blocks, patches };
}

export function extractDocPage(document: any): ExtractedDocPage {
  const { node: root, rootFound } = findContentRoot(document);
  const { blocks, patches } = collectBlocks(root);

  return {
    title: titleFromDocument(document),
    rootFound,
    blocks,
    patches
  };
}
