type ArkMessage = {
  role: "system" | "user";
  content: string;
};

type ArkChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_MODEL = "doubao-seed-1-6-flash-250615";
const DEFAULT_TIMEOUT_MS = 60000;

type ArkJsonCompletionInput = {
  system: string;
  user: unknown;
  model?: string;
  timeoutMs?: number;
  errorPrefix?: string;
};

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function extractJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    const match = value.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) {
      throw new Error("Ark model did not return JSON.");
    }
    return JSON.parse(match[0]);
  }
}

function validTimeout(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

async function completeArkJson(
  messages: ArkMessage[],
  model: string,
  timeoutMs: number,
  errorPrefix: string
): Promise<unknown> {
  const apiKey = process.env.ARK_API_KEY;
  const baseUrl = process.env.ARK_BASE_URL || DEFAULT_BASE_URL;

  if (!apiKey) {
    throw new Error("Missing ARK_API_KEY.");
  }

  const { response, payload } = await withTimeout(
    async (signal) => {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0,
          response_format: { type: "json_object" }
        }),
        signal,
        cache: "no-store"
      });
      const rawPayload = await response.text();
      const payload = rawPayload ? (JSON.parse(rawPayload) as ArkChatResponse) : {};
      return { response, payload };
    },
    validTimeout(timeoutMs)
  );

  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message || `${errorPrefix} failed with status ${response.status}.`);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Ark model returned an empty response.");
  }

  return extractJson(content);
}

export async function completeJsonWithArk(input: ArkJsonCompletionInput): Promise<unknown> {
  const model = input.model || process.env.ARK_MODEL || DEFAULT_MODEL;
  const timeoutMs = input.timeoutMs ?? Number(process.env.ARK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const userContent = typeof input.user === "string" ? input.user : JSON.stringify(input.user);

  return completeArkJson(
    [
      {
        role: "system",
        content: input.system
      },
      {
        role: "user",
        content: userContent
      }
    ],
    model,
    timeoutMs,
    input.errorPrefix || "Ark completion"
  );
}

export async function translateWithArk(textList: string[], targetLanguage: string): Promise<string[]> {
  const model = process.env.ARK_MODEL || DEFAULT_MODEL;
  const timeoutMs = Number(process.env.ARK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

  const messages: ArkMessage[] = [
    {
      role: "system",
      content:
        'You are a precise documentation translator. Translate only natural language text into the target language. Preserve Markdown, inline code, placeholders, product names, URLs, paths, commands, punctuation shape, and array length. Return only valid JSON in this shape: {"translations":["..."]}.'
    },
    {
      role: "user",
      content: JSON.stringify({
        targetLanguage,
        texts: textList
      })
    }
  ];

  const parsed = await completeArkJson(messages, model, timeoutMs, "Ark translation");
  const translations = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { translations?: unknown }).translations)
      ? (parsed as { translations: unknown[] }).translations
      : null;

  if (!translations || translations.length !== textList.length) {
    throw new Error("Ark model returned an unexpected translation shape.");
  }

  return translations.map((item, index) => (typeof item === "string" ? item : textList[index]));
}
