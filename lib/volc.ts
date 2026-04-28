import crypto from "node:crypto";

export type TranslateRequest = {
  textList: string[];
  targetLanguage: string;
  sourceLanguage?: string;
};

type VolcTranslateResponse = {
  TranslationList?: Array<{ Translation: string; DetectedSourceLanguage?: string }>;
  ResponseMetadata?: {
    Error?: {
      Code: string;
      Message: string;
    };
  };
};

const endpoint = "https://translate.volcengineapi.com";

function hmac(key: crypto.BinaryLike | crypto.KeyObject, value: string): Buffer {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function formatXDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function signRequest(body: string, now = new Date()): HeadersInit {
  const accessKey = process.env.VOLC_ACCESS_KEY_ID;
  const secretKey = process.env.VOLC_SECRET_ACCESS_KEY;
  const region = process.env.VOLC_REGION || "cn-north-1";
  const service = process.env.VOLC_TRANSLATE_SERVICE || "translate";

  if (!accessKey || !secretKey) {
    throw new Error("Missing VOLC_ACCESS_KEY_ID or VOLC_SECRET_ACCESS_KEY.");
  }

  const xDate = formatXDate(now);
  const shortDate = xDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const signedHeaders = "content-type;host;x-content-sha256;x-date";
  const canonicalHeaders = [
    "content-type:application/json",
    "host:translate.volcengineapi.com",
    `x-content-sha256:${payloadHash}`,
    `x-date:${xDate}`
  ].join("\n");
  const canonicalRequest = [
    "POST",
    "/",
    "Action=TranslateText&Version=2020-06-01",
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash
  ].join("\n");
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = ["HMAC-SHA256", xDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(secretKey, shortDate), region), service), "request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    authorization: `HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "content-type": "application/json",
    host: "translate.volcengineapi.com",
    "x-content-sha256": payloadHash,
    "x-date": xDate
  };
}

export async function translateWithVolc({
  textList,
  targetLanguage,
  sourceLanguage
}: TranslateRequest): Promise<string[]> {
  if (textList.length === 0) {
    return [];
  }

  const body = JSON.stringify({
    TargetLanguage: targetLanguage,
    TextList: textList,
    ...(sourceLanguage ? { SourceLanguage: sourceLanguage } : {})
  });

  const response = await fetch(`${endpoint}/?Action=TranslateText&Version=2020-06-01`, {
    method: "POST",
    headers: signRequest(body),
    body,
    cache: "no-store"
  });

  const rawPayload = await response.text();
  const payload = rawPayload ? (JSON.parse(rawPayload) as VolcTranslateResponse) : {};
  const apiError = payload.ResponseMetadata?.Error;
  if (!response.ok || apiError) {
    throw new Error(apiError?.Message || `Volc translation failed with status ${response.status}.`);
  }

  const translations = payload.TranslationList?.map((item) => item.Translation) ?? [];
  if (translations.length !== textList.length) {
    throw new Error("Volc translation returned an unexpected number of results.");
  }

  return translations;
}
