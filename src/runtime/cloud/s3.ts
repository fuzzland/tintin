import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { CloudUiSection } from "../config.js";

const clients = new Map<string, S3Client>();

function clientKey(cfg: CloudUiSection): string {
  return `${cfg.s3_region}:${cfg.s3_bucket}`;
}

function getClient(cfg: CloudUiSection): S3Client {
  const key = clientKey(cfg);
  const existing = clients.get(key);
  if (existing) return existing;
  const client = new S3Client({
    region: cfg.s3_region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
  });
  clients.set(key, client);
  return client;
}

export async function uploadScreenshot(cfg: CloudUiSection, opts: { key: string; body: Buffer; contentType?: string }) {
  const client = getClient(cfg);
  const command = new PutObjectCommand({
    Bucket: cfg.s3_bucket,
    Key: opts.key,
    Body: opts.body,
    ContentType: opts.contentType,
  });
  await client.send(command);
}

export async function signScreenshotUrl(cfg: CloudUiSection, key: string): Promise<string> {
  const client = getClient(cfg);
  const command = new GetObjectCommand({
    Bucket: cfg.s3_bucket,
    Key: key,
  });
  const expiresIn = Math.max(1, Math.floor(cfg.s3_signed_url_ttl_ms / 1000));
  return await getSignedUrl(client, command, { expiresIn });
}

export async function deleteS3Object(cfg: CloudUiSection, key: string): Promise<void> {
  const client = getClient(cfg);
  const command = new DeleteObjectCommand({
    Bucket: cfg.s3_bucket,
    Key: key,
  });
  await client.send(command);
}
