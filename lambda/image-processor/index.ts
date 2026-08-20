import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  S3Event,
  S3EventRecord,
  SQSBatchResponse,
  SQSEvent,
} from "aws-lambda";
import sharp = require("sharp");
import type { FitEnum } from "sharp";

interface ImageVariantConfig {
  name: "thumb" | "medium" | "large";
  width: number;
  height: number;
  fit: keyof FitEnum;
}

interface ProcessedKeyParts {
  purpose: string;
  ownerId: string;
  assetId: string;
}

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "ap-southeast-1",
});

const BUCKET = process.env.AWS_S3_BUCKET;
const ORIGINAL_PREFIX = "uploads/original/";
const PROCESSED_PREFIX = "media/processed/";
const VARIANT_MARKER = /\/(thumb|medium|large)\.webp$/;
const IMAGE_EXTENSION_PATTERN = /\.(?:jpe?g|png|webp)$/i;

const VARIANTS: ImageVariantConfig[] = [
  { name: "thumb", width: 128, height: 128, fit: "cover" },
  { name: "medium", width: 512, height: 512, fit: "inside" },
  { name: "large", width: 1080, height: 1080, fit: "inside" },
];

// Lambda entrypoint: nhận event trực tiếp từ S3 hoặc event SQS bọc S3 event để resize ảnh bất đồng bộ.
export async function handler(
  event: S3Event | SQSEvent,
): Promise<{ statusCode: number } | SQSBatchResponse> {
  if (!BUCKET) {
    throw new Error("AWS_S3_BUCKET is not configured");
  }

  if (isSqsEvent(event)) {
    return handleSqsEvent(event);
  }

  const records = extractS3Records(event);
  await Promise.all(records.map((record) => processS3Record(record)));

  return { statusCode: 200 };
}

// Xử lý batch SQS và trả batchItemFailures để AWS chỉ retry những message lỗi.
async function handleSqsEvent(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse["batchItemFailures"] = [];

  for (const message of event.Records) {
    try {
      const s3Records = extractS3Records(JSON.parse(message.body) as S3Event);
      await Promise.all(s3Records.map((record) => processS3Record(record)));
    } catch (error) {
      console.error("Failed to process SQS image message", {
        messageId: message.messageId,
        error,
      });
      failures.push({ itemIdentifier: message.messageId });
    }
  }

  return { batchItemFailures: failures };
}

// Kiểm tra event có phải SQS hay không để handler dùng được cho cả S3 trigger trực tiếp và SQS trigger.
function isSqsEvent(event: S3Event | SQSEvent): event is SQSEvent {
  return event.Records.some((record) => "messageId" in record);
}

// Lấy danh sách S3 record hợp lệ, bỏ qua record rỗng để Lambda không fail vô ích.
function extractS3Records(event: S3Event): S3EventRecord[] {
  return event.Records?.filter((record) => record.s3?.object?.key) ?? [];
}

// Xử lý một object ảnh gốc: tải từ S3, resize các biến thể rồi upload vào prefix processed.
async function processS3Record(record: S3EventRecord): Promise<void> {
  const sourceKey = decodeS3Key(record.s3.object.key);

  if (!shouldProcessKey(sourceKey)) {
    console.log(`Skipping object: ${sourceKey}`);
    return;
  }

  console.log(`Processing original image: ${sourceKey}`);

  const originalBuffer = await downloadObject(sourceKey);
  const keyParts = parseOriginalKey(sourceKey);

  await Promise.all(
    VARIANTS.map((variant) =>
      resizeAndUploadVariant(originalBuffer, keyParts, variant),
    ),
  );

  console.log(`Done processing image: ${sourceKey}`);
}

// Decode key vì S3 event encode khoảng trắng thành dấu cộng và dùng percent-encoding.
function decodeS3Key(encodedKey: string): string {
  return decodeURIComponent(encodedKey.replace(/\+/g, " "));
}

// Chỉ xử lý ảnh gốc trong uploads/original và bỏ qua output để tránh vòng lặp trigger vô hạn.
function shouldProcessKey(sourceKey: string): boolean {
  return (
    sourceKey.startsWith(ORIGINAL_PREFIX) &&
    !sourceKey.startsWith(PROCESSED_PREFIX) &&
    !VARIANT_MARKER.test(sourceKey) &&
    IMAGE_EXTENSION_PATTERN.test(sourceKey)
  );
}

// Tải object gốc thành Buffer vì sharp cần input ổn định để resize nhiều biến thể từ cùng một ảnh.
async function downloadObject(sourceKey: string): Promise<Buffer> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: sourceKey }),
  );

  if (!response.Body) {
    throw new Error(`Empty S3 object body: ${sourceKey}`);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of response.Body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

// Tách key uploads/original/{purpose}/{ownerId}/{assetId}/{file} để output giữ đúng ngữ cảnh ảnh.
function parseOriginalKey(sourceKey: string): ProcessedKeyParts {
  const parts = sourceKey.split("/");
  const [, , purpose, ownerId, assetId] = parts;

  if (!purpose || !ownerId || !assetId) {
    throw new Error(`Invalid original image key: ${sourceKey}`);
  }

  return { purpose, ownerId, assetId };
}

// Resize một biến thể sang WebP, strip metadata và lưu cache immutable cho CloudFront.
async function resizeAndUploadVariant(
  originalBuffer: Buffer,
  keyParts: ProcessedKeyParts,
  variant: ImageVariantConfig,
): Promise<void> {
  const variantBuffer = await sharp(originalBuffer)
    .rotate()
    .resize(variant.width, variant.height, {
      fit: variant.fit,
      withoutEnlargement: true,
    })
    .webp({ quality: 82 })
    .toBuffer();

  const variantKey = buildProcessedVariantKey(keyParts, variant.name);

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: variantKey,
      Body: variantBuffer,
      ContentType: "image/webp",
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  console.log(`Uploaded variant: ${variantKey}`, {
    bytes: variantBuffer.length,
  });
}

// Sinh key output ổn định để frontend/DB có thể suy ra các biến thể từ assetId.
function buildProcessedVariantKey(
  keyParts: ProcessedKeyParts,
  variantName: ImageVariantConfig["name"],
): string {
  return [
    PROCESSED_PREFIX.replace(/\/$/, ""),
    keyParts.purpose,
    keyParts.ownerId,
    keyParts.assetId,
    `${variantName}.webp`,
  ].join("/");
}
