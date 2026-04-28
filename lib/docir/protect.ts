import type { ProtectedToken } from "./types";

const PROTECTED_PATTERNS = [
  /https?:\/\/[^\s)]+/g,
  /`[^`]+`/g,
  /\b[A-Z0-9_]{3,}\b/g,
  /--[a-z0-9][a-z0-9-]*/gi,
  /@[a-z0-9_.-]+\/[a-z0-9_.-]+/gi,
  /(?:\.{0,2}\/)?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+){1,}/gi,
  /\{[a-z0-9_.:-]+\}/gi,
  /<[A-Z][A-Za-z0-9.]*\/?>/g
];

export function protectText(source: string): { text: string; tokens: ProtectedToken[] } {
  const tokens: ProtectedToken[] = [];
  let text = source;

  for (const pattern of PROTECTED_PATTERNS) {
    text = text.replace(pattern, (value) => {
      const existing = tokens.find((token) => token.value === value);
      if (existing) {
        return existing.placeholder;
      }

      const placeholder = `xxdntoken${tokens.length}xx`;
      tokens.push({ placeholder, value });
      return placeholder;
    });
  }

  return { text, tokens };
}

export function restoreText(translated: string, tokens: ProtectedToken[]): string {
  let text = translated;
  for (const token of tokens) {
    text = text.split(token.placeholder).join(token.value);
  }
  return text;
}
