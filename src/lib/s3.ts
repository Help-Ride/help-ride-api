// src/lib/s3.ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

const bucket = process.env.AWS_S3_BUCKET
const region = process.env.AWS_REGION || "us-east-1"
const publicBaseUrl = process.env.AWS_S3_PUBLIC_BASE_URL?.replace(/\/+$/, "")

if (!bucket) {
  throw new Error("AWS_S3_BUCKET is not set")
}

export const s3 = new S3Client({ region })

export async function getUploadUrl(opts: {
  key: string
  contentType: string
  expiresInSeconds?: number
}) {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: opts.key,
    ContentType: opts.contentType,
  })

  return getSignedUrl(s3, command, {
    expiresIn: opts.expiresInSeconds ?? 900, // 15 min
  })
}

export async function getDownloadUrl(key: string, expiresInSeconds = 900) {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  })

  return getSignedUrl(s3, command, {
    expiresIn: expiresInSeconds,
  })
}

export function getPublicFileUrl(key: string) {
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")

  if (publicBaseUrl) {
    return `${publicBaseUrl}/${encodedKey}`
  }

  if (region === "us-east-1") {
    return `https://${bucket}.s3.amazonaws.com/${encodedKey}`
  }

  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`
}
