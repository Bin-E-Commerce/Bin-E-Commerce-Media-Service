import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "ap-southeast-1",
});

const BUCKET = process.env.AWS_S3_BUCKET;
const ORIGINAL_PREFIX = "uploads/original/";
const PROCESSED_PREFIX = "media/processed/";
const WORK_DIR = "/tmp/video-processor";
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? "/opt/bin/ffmpeg";

type VideoVariant = {
  name: "360p" | "720p" | "1080p";
  width: number;
  height: number;
  bitrate: string;
};

type VideoKeyParts = {
  purpose: string;
  ownerId: string;
  assetId: string;
};

const VARIANTS: VideoVariant[] = [
  { name: "360p", width: 640, height: 360, bitrate: "900k" },
  { name: "720p", width: 1280, height: 720, bitrate: "2500k" },
  { name: "1080p", width: 1920, height: 1080, bitrate: "5000k" },
];

// Lambda entrypoint nhận SQS batch và chỉ báo lỗi từng message để AWS retry đúng video hỏng.
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  if (!BUCKET) throw new Error("AWS_S3_BUCKET is not configured");

  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

  for (const message of event.Records) {
    try {
      const s3Event = JSON.parse(message.body) as S3Event;
      const records = extractS3Records(s3Event);

      // Một message có thể chứa nhiều object; xử lý tuần tự giúp giới hạn dung lượng /tmp và RAM của Lambda.
      for (const record of records) await processS3Record(record);
    } catch (error) {
      console.error("Failed to process SQS video message", {
        messageId: message.messageId,
        error,
      });
      batchItemFailures.push({ itemIdentifier: message.messageId });
    }
  }

  return { batchItemFailures };
}

// Lọc record có key hợp lệ; record rỗng không được làm hỏng cả batch SQS.
function extractS3Records(event: S3Event): S3EventRecord[] {
  return event.Records?.filter((record) => Boolean(record.s3?.object?.key)) ?? [];
}

// Tải video gốc, tạo các bản phân giải độc lập và ghi manifest để frontend có thể chọn bản phù hợp.
async function processS3Record(record: S3EventRecord): Promise<void> {
  const sourceKey = decodeS3Key(record.s3.object.key);

  if (!shouldProcessKey(sourceKey)) {
    console.log(`Skipping non-video object: ${sourceKey}`);
    return;
  }

  const keyParts = parseOriginalKey(sourceKey);
  const inputPath = `${WORK_DIR}/${keyParts.assetId}-original`;

  await mkdir(WORK_DIR, { recursive: true });
  try {
    await downloadToFile(sourceKey, inputPath);
    // FFmpeg tiêu thụ nhiều CPU/RAM; chạy tuần tự giúp Lambda ổn định khi xử lý video lớn.
    // SQS vẫn đảm nhiệm việc mở rộng theo nhiều message, nên không cần chạy ba FFmpeg đồng thời trong một invocation.
    for (const variant of VARIANTS) {
      await transcodeVariant(inputPath, keyParts, variant);
    }

    await createPoster(inputPath, keyParts);
    await uploadManifest(keyParts);
    console.log(`Done processing video: ${sourceKey}`);
  } finally {
    // Xóa file tạm để lần chạy kế tiếp không bị đầy /tmp, kể cả khi FFmpeg lỗi.
    await rm(inputPath, { force: true }).catch(() => undefined);
  }
}

// Chỉ nhận video gốc product_video; output processed và ảnh/video khác không được chạy lại.
function shouldProcessKey(sourceKey: string): boolean {
  return (
    sourceKey.startsWith(`${ORIGINAL_PREFIX}product_video/`) &&
    !sourceKey.startsWith(PROCESSED_PREFIX) &&
    /\.(mp4|webm|mov|m4v)$/i.test(sourceKey)
  );
}

// Giải mã key do S3 encode dấu cách và ký tự đặc biệt trong event notification.
function decodeS3Key(encodedKey: string): string {
  return decodeURIComponent(encodedKey.replace(/\+/g, " "));
}

// Tách uploads/original/{purpose}/{ownerId}/{assetId}/{filename} để giữ đúng tenant khi ghi output.
function parseOriginalKey(sourceKey: string): VideoKeyParts {
  const [, , purpose, ownerId, assetId] = sourceKey.split("/");
  if (!purpose || !ownerId || !assetId) {
    throw new Error(`Invalid original video key: ${sourceKey}`);
  }
  return { purpose, ownerId, assetId };
}

// Stream video trực tiếp xuống /tmp thay vì giữ toàn bộ file trong RAM của Lambda.
async function downloadToFile(sourceKey: string, destinationPath: string): Promise<void> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: sourceKey }),
  );
  if (!response.Body) throw new Error(`Empty S3 object body: ${sourceKey}`);
  await pipeline(
    Readable.from(response.Body as AsyncIterable<Uint8Array>),
    createWriteStream(destinationPath),
  );
}

// Chuyển mã MP4 H.264/AAC, giữ tỉ lệ ảnh và không upscale video nhỏ hơn profile đích.
async function transcodeVariant(
  inputPath: string,
  keyParts: VideoKeyParts,
  variant: VideoVariant,
): Promise<void> {
  const outputPath = `${WORK_DIR}/${keyParts.assetId}-${variant.name}.mp4`;
  const scale = `scale='min(${variant.width},iw)':'min(${variant.height},ih)':force_original_aspect_ratio=decrease`;

  await execFileAsync(FFMPEG_PATH, [
    "-y",
    "-i",
    inputPath,
    "-vf",
    scale,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-maxrate",
    variant.bitrate,
    "-bufsize",
    `${variant.bitrate.replace("k", "")}k`,
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outputPath,
  ]);

  await uploadFile(
    outputPath,
    buildProcessedKey(keyParts, `${variant.name}.mp4`),
    "video/mp4",
  );
  await rm(outputPath, { force: true });
}

// Tạo poster WebP từ frame đầu để product card và preview không cần tải cả video.
async function createPoster(inputPath: string, keyParts: VideoKeyParts): Promise<void> {
  const posterPath = `${WORK_DIR}/${keyParts.assetId}-poster.webp`;
  await execFileAsync(FFMPEG_PATH, [
    "-y",
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    "scale='min(640,iw)':'min(640,ih)':force_original_aspect_ratio=decrease",
    "-c:v",
    "libwebp",
    "-q:v",
    "5",
    posterPath,
  ]);
  await uploadFile(
    posterPath,
    buildProcessedKey(keyParts, "poster.webp"),
    "image/webp",
  );
  await rm(posterPath, { force: true });
}

// Lưu manifest ổn định để client biết video đã READY và các URL biến thể nào có thể phát.
async function uploadManifest(keyParts: VideoKeyParts): Promise<void> {
  const manifest = {
    assetId: keyParts.assetId,
    status: "READY",
    variants: VARIANTS.map(({ name }) => ({
      name,
      key: buildProcessedKey(keyParts, `${name}.mp4`),
    })),
    posterKey: buildProcessedKey(keyParts, "poster.webp"),
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: buildProcessedKey(keyParts, "manifest.json"),
      Body: JSON.stringify(manifest),
      ContentType: "application/json",
      CacheControl: "no-cache, no-store, must-revalidate",
    }),
  );
}

// Đẩy file đã xử lý lên prefix riêng để S3 event không quay lại xử lý lần hai.
async function uploadFile(
  filePath: string,
  key: string,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: createReadStream(filePath),
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  console.log(`Uploaded video asset: ${key}`);
}

// Sinh key CDN ổn định theo asset để database chỉ cần lưu assetId/manifest URL.
function buildProcessedKey(keyParts: VideoKeyParts, fileName: string): string {
  return [
    PROCESSED_PREFIX.replace(/\/$/, ""),
    keyParts.purpose,
    keyParts.ownerId,
    keyParts.assetId,
    fileName,
  ].join("/");
}
