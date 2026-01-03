import crypto from "node:crypto";

const PREFIX = "v1";

function deriveKey(secretKey: string): Buffer {
  if (!secretKey || secretKey.trim().length === 0) {
    throw new Error("Missing cloud.secrets_key");
  }
  return crypto.createHash("sha256").update(secretKey, "utf8").digest();
}

export function encryptSecret(plaintext: string, secretKey: string): string {
  const key = deriveKey(secretKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(ciphertext: string, secretKey: string): string {
  const key = deriveKey(secretKey);
  const parts = ciphertext.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error("Unsupported secret format");
  const iv = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");
  const data = Buffer.from(parts[3]!, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

export function interpolateSecrets(input: string, resolver: (name: string) => string | null): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch !== "%") {
      out += ch;
      i++;
      continue;
    }
    const next = input[i + 1];
    if (next === "%") {
      out += "%";
      i += 2;
      continue;
    }
    const end = input.indexOf("%", i + 1);
    if (end === -1) {
      out += "%";
      i++;
      continue;
    }
    const name = input.slice(i + 1, end);
    const value = resolver(name);
    if (value === null) {
      out += `%${name}%`;
    } else {
      out += value;
    }
    i = end + 1;
  }
  return out;
}
