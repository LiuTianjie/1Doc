export function encodeCursor(value: Record<string, string> | null): string | null {
  if (!value) {
    return null;
  }

  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor<T extends Record<string, string>>(
  value: string | null,
  keys: Array<keyof T>
): T | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<T>;
    if (keys.every((key) => typeof parsed[key] === "string" && parsed[key])) {
      return parsed as T;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function normalizeLimit(value: string | null, fallback: number, max: number): number {
  if (!value) {
    return fallback;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(1, Math.min(max, Math.floor(numeric)));
}
