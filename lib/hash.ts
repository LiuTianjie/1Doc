import crypto from "node:crypto";

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function textHash(text: string): string {
  return sha256(text.normalize("NFC"));
}
