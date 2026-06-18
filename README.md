# Media Service

Image uploads should not clog the backend. This service grants direct upload access to S3, asynchronously resizes images using Lambda, and then optimally distributes the images via CloudFront.

```text
Frontend -> Media Service -> S3 -> SQS/Lambda -> S3 processed images -> CloudFront
```

---

## Why It Exists

In e-commerce, images are everywhere: avatars, product images, shop images, review images, chat images. If every file went through the backend, the service would consume RAM, CPU, and bandwidth, and could easily become congested when users upload many images simultaneously.

Media Services solves this by letting the backend only do what it should: verify upload permissions, grant presigned upload policies, and manage metadata. Large files go directly from the browser to S3, while resizing runs in the background using Lambda.

---

## Trust & Security

This service touches external infrastructure, so the permission surface is explicit.

| Concern                     | Design                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Backend receives raw files? | No. Browser uploads directly to S3 using presigned POST.                                                            |
| Who chooses the S3 key?     | Backend only. Client cannot choose arbitrary paths.                                                                 |
| Upload expiry               | Presigned POST expires through `MEDIA_UPLOAD_EXPIRES_SECONDS`.                                                      |
| File type control           | DTO validation plus S3 POST policy restricts MIME type. Lambda should still validate magic bytes in the next phase. |
| File size control           | DTO validation plus S3 content-length-range policy.                                                                 |
| Bucket visibility           | Designed for private S3 bucket plus CloudFront, not public S3 reads.                                                |
| Resize loop prevention      | Lambda only processes `uploads/original/*` and skips processed variants.                                            |
| Failure isolation           | Handler supports SQS batch failures, so one bad image does not poison the whole batch.                              |
| Old avatar cleanup          | Media Service derives prefixes from authenticated user ID plus asset ID; clients cannot submit arbitrary S3 keys.  |

---

## Architecture

```text
1. Frontend asks Media Service for upload permission
2. Media Service validates user context, file type, file size and purpose
3. Media Service returns presigned POST fields
4. Frontend uploads the original file directly to S3
5. S3 emits ObjectCreated event
6. Event goes directly to Lambda or through SQS
7. Lambda downloads original image from S3
8. Lambda creates WebP variants with sharp
9. Lambda writes processed images back to S3
10. CloudFront serves processed images to the application
```

<details>
<summary><b>Detailed flow</b></summary>

```text
Frontend
  -> POST /api/v1/media/uploads/presign
  -> receives assetId + presigned POST
  -> uploads file to uploads/original/{purpose}/{userId}/{assetId}/{file}

S3
  -> ObjectCreated event
  -> SQS queue, recommended for production

Lambda image-processor
  -> reads SQS message or S3 event
  -> downloads original
  -> creates thumb, medium, large variants
  -> writes to media/processed/{purpose}/{userId}/{assetId}/{variant}.webp

CloudFront
  -> serves processed images with immutable cache headers
```

</details>

### Two independent deployables

The repository contains two runtimes with different responsibilities:

| Runtime | Source | Responsibility | Deployment target |
| --- | --- | --- | --- |
| Media HTTP service | `src/app.module.ts` | Validate upload requests and create presigned S3 POST policies | Local process, container, ECS or Kubernetes |
| Image processor | `lambda/image-processor/index.ts` | Consume S3/SQS events and create WebP variants | AWS Lambda |

Deploying the NestJS media service does not update Lambda. Deploying Lambda does not restart the HTTP service.

---

## Quick Demo

Start the service:

```bash
npm run dev -w @bin-ecommerce/media-service
```

Request a presigned upload:

```bash
curl -X POST http://localhost:3010/api/v1/media/uploads/presign \
  -H "Content-Type: application/json" \
  -H "x-user-id: user_123" \
  -d '{
    "fileName": "avatar.jpg",
    "contentType": "image/jpeg",
    "fileSize": 1200000,
    "purpose": "avatar"
  }'
```

Example response:

```json
{
  "assetId": "7c1b8b3a-7a73-4d65-8d10-9f6f4d3ef9d2",
  "objectKey": "uploads/original/avatar/user_123/7c1b8b3a-7a73-4d65-8d10-9f6f4d3ef9d2/avatar.jpg",
  "expiresIn": 300,
  "status": "uploading",
  "upload": {
    "url": "https://bin-ecommerce-media-dev.s3.amazonaws.com",
    "fields": {
      "Content-Type": "image/jpeg",
      "key": "uploads/original/avatar/user_123/7c1b8b3a-7a73-4d65-8d10-9f6f4d3ef9d2/avatar.jpg"
    }
  },
  "publicBaseUrl": "https://cdn.example.com"
}
```

Build the Lambda processor package:

```powershell
npm run lambda:build
```

Deploy it to the existing AWS function:

```powershell
npm run lambda:deploy
```

Deploy an already-built zip:

```powershell
npm run lambda:deploy -- -SkipBuild
```

Smoke-test an existing original image:

```powershell
npm run lambda:verify -- -ObjectKey "uploads/original/avatar/{userId}/{assetId}/avatar.jpg"
```

Verify the full asynchronous event pipeline:

```powershell
npm run lambda:verify-pipeline -- -SourceObjectKey "uploads/original/avatar/{userId}/{assetId}/avatar.jpg"
```

---

## API

### `POST /api/v1/media/uploads/presign`

Creates a presigned S3 POST policy. The caller uploads the file directly to S3 using the returned `url` and `fields`.

Required header:

```text
x-user-id: <authenticated-user-id>
```

Request body:

```json
{
  "fileName": "product-main.jpg",
  "contentType": "image/jpeg",
  "fileSize": 2400000,
  "purpose": "product_image"
}
```

Supported `purpose` values:

```text
avatar
product_image
shop_avatar
shop_cover
review_image
chat_image
```

Supported MIME types:

```text
image/jpeg
image/png
image/webp
```

### `POST /api/v1/media/assets/avatar/:assetId/confirm`

Confirms that Lambda has created `medium.webp`, updates `users.avatar_url`
through the internal Auth Service endpoint, and then removes the previous
avatar asset.

The client sends only `assetId`. Media Service derives the owner and CloudFront
URL from trusted server configuration, so the client cannot submit an arbitrary
avatar URL.

```json
{
  "assetId": "7c1b8b3a-7a73-4d65-8d10-9f6f4d3ef9d2",
  "avatarUrl": "https://cdn.example.com/media/processed/avatar/user-id/7c1b8b3a-7a73-4d65-8d10-9f6f4d3ef9d2/medium.webp",
  "cleanup": {
    "status": "deleted",
    "oldAssetId": "6b0a7604-3a15-4c37-bc15-6a039e14e895",
    "deletedCount": 4
  }
}
```

If cleanup fails after the profile update, the endpoint still returns the new
avatar with `cleanup.status = "deferred"`. A cleanup failure must not roll back
a valid profile update.

### `DELETE /api/v1/media/assets/avatar/:assetId`

Deletes the original object and all processed variants of an old avatar owned by the authenticated user.

### `DELETE /api/v1/media/assets/avatar?keepAssetId=:assetId`

Keeps the current avatar asset and removes every other avatar asset owned by the authenticated user.

The frontend calls this endpoint only after the profile has switched to the new avatar. It also cleans orphan assets left by interrupted or previously failed cleanup attempts. Ownership comes from the gateway-injected `x-user-id`, not from a client-provided S3 path.

### Health endpoints

| Endpoint                   | Purpose                                                             | Success |
| -------------------------- | ------------------------------------------------------------------- | ------- |
| `GET /api/v1/health/live`  | Confirms that the Node.js process and HTTP server are alive.        | `200`   |
| `GET /api/v1/health/ready` | Validates required media configuration and actual S3 bucket access. | `200`   |
| `GET /api/v1/health`       | Backward-compatible alias for the full readiness check.             | `200`   |

Readiness returns `503 Service Unavailable` when the bucket cannot be reached,
the runtime lacks permission, or required configuration is missing. Docker
uses the liveness endpoint so a temporary AWS incident does not restart an
otherwise healthy process.

Example readiness response:

```json
{
  "status": "ok",
  "info": {
    "configuration": {
      "status": "up",
      "cdnUrlValid": true,
      "region": "ap-southeast-1"
    },
    "s3": {
      "status": "up",
      "bucket": "bin-ecommerce-media-dev",
      "latencyMs": 142,
      "region": "ap-southeast-1"
    }
  },
  "service": "media-service",
  "version": "1.0.0",
  "environment": "development"
}
```

---

## S3 Key Strategy

Original uploads:

```text
uploads/original/{purpose}/{userId}/{assetId}/{safeFileName}.{ext}
```

Processed variants:

```text
media/processed/{purpose}/{userId}/{assetId}/thumb.webp
media/processed/{purpose}/{userId}/{assetId}/medium.webp
media/processed/{purpose}/{userId}/{assetId}/large.webp
```

Why this shape:

- `purpose` separates business use cases such as avatar and product image.
- `userId` keeps ownership visible in the object path.
- `assetId` gives every upload an immutable identity.
- Processed images are separated from originals to prevent recursive processing.

---

## Lambda Image Processor

Source:

```text
lambda/image-processor/index.ts
```

Variants:

| Variant  | Size        | Fit    | Format |
| -------- | ----------- | ------ | ------ |
| `thumb`  | 128 x 128   | cover  | WebP   |
| `medium` | 512 x 512   | inside | WebP   |
| `large`  | 1080 x 1080 | inside | WebP   |

The Lambda uses `sharp` to:

- rotate images according to EXIF orientation,
- avoid upscaling small images,
- convert output to WebP,
- write long-lived cache headers for CDN delivery.

<details>
<summary><b>Supported trigger modes</b></summary>

### MVP mode

```text
S3 ObjectCreated -> Lambda
```

This is simpler to set up and good for early development.

### Production mode

```text
S3 ObjectCreated -> SQS -> Lambda
```

This is recommended for production because SQS gives controlled retries, failure isolation and dead-letter queue support.

</details>

---

## Environment Variables

Media Service:

```text
PORT=3010
NODE_ENV=development
AWS_REGION=ap-southeast-1
AWS_S3_BUCKET=bin-ecommerce-media-dev
AUTH_SERVICE_URL=http://localhost:3001
INTERNAL_SERVICE_TOKEN=replace-with-a-long-random-secret
MEDIA_PUBLIC_CDN_URL=https://cdn.example.com
MEDIA_UPLOAD_EXPIRES_SECONDS=300
MEDIA_MAX_UPLOAD_SIZE_BYTES=5242880
```

Lambda:

```text
AWS_S3_BUCKET=bin-ecommerce-media-dev
```

`AWS_REGION` is supplied by the Lambda runtime and must not be added manually as a Lambda environment variable.

---

## AWS Setup Checklist

<details>
<summary><b>S3 bucket</b></summary>

- Create a private bucket, for example `bin-ecommerce-media-dev`.
- Block public access.
- Add CORS for browser uploads.
- Configure ObjectCreated event on prefix `uploads/original/`.
- Route the event to Lambda directly for MVP or SQS for production.

Example CORS:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["POST"],
    "AllowedOrigins": ["http://localhost:5173"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

</details>

<details>
<summary><b>IAM permissions</b></summary>

Media Service needs permission to create presigned POST policies for the upload prefix:

```text
s3:PutObject on arn:aws:s3:::<bucket>/uploads/original/*
```

To clean up old avatars, the Media Service runtime role also needs:

```text
s3:GetObject on arn:aws:s3:::<bucket>/media/processed/avatar/*
s3:ListBucket on arn:aws:s3:::<bucket>
  restricted to uploads/original/avatar/* and media/processed/avatar/*
s3:DeleteObject on arn:aws:s3:::<bucket>/uploads/original/avatar/*
s3:DeleteObject on arn:aws:s3:::<bucket>/media/processed/avatar/*
```

Lambda needs:

```text
s3:GetObject on arn:aws:s3:::<bucket>/uploads/original/*
s3:PutObject on arn:aws:s3:::<bucket>/media/processed/*
```

If Lambda reads from SQS:

```text
sqs:ReceiveMessage
sqs:DeleteMessage
sqs:GetQueueAttributes
```

</details>

<details>
<summary><b>CloudFront</b></summary>

Recommended setup:

- S3 bucket remains private.
- CloudFront uses Origin Access Control.
- Application reads processed images through CDN URLs.
- Processed images use `Cache-Control: public, max-age=31536000, immutable`.

</details>

---

## Local Development

Install dependencies:

```bash
npm install -w @bin-ecommerce/media-service
```

Type-check:

```bash
npm run type-check -w @bin-ecommerce/media-service
```

Build service:

```bash
npm run build -w @bin-ecommerce/media-service
```

Compile Lambda TypeScript only:

```bash
npm run build:lambda -w @bin-ecommerce/media-service
```

Build the complete Linux x64 deployment package:

```powershell
npm run lambda:build
```

See [docs/aws-s3-lambda-deployment.md](docs/aws-s3-lambda-deployment.md) for deployment and verification.

Run service:

```bash
npm run dev -w @bin-ecommerce/media-service
```
