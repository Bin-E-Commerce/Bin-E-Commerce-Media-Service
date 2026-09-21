<p align="center">
  <img src="https://raw.githubusercontent.com/Bin-E-Commerce/Bin-E-Commerce-UI-Web/main/public/images/logo/logo_background_white.png" alt="Bin E-Commerce" width="190" />
</p>

<h1 align="center">Media Service</h1>

<p align="center">
  Move every image and video from upload to secure CDN delivery without exposing storage credentials.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white" alt="NestJS 11" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/AWS-S3-FF9900?logo=amazonaws&logoColor=white" alt="AWS S3" />
  <img src="https://img.shields.io/badge/Sharp-image%20processing-99CC00?logo=sharp&logoColor=111111" alt="Sharp" />
  <img src="https://img.shields.io/badge/Lambda-processing-FF9900?logo=awslambda&logoColor=white" alt="AWS Lambda" />
  <img src="https://img.shields.io/badge/CloudFront-CDN-8C4FFF?logo=amazonaws&logoColor=white" alt="CloudFront" />
</p>

## Contents

1. [Problem](#1-problem)
2. [Service at a glance](#2-service-at-a-glance)
3. [What it owns](#3-what-it-owns)
4. [Architecture](#4-architecture)
5. [Trust surface](#5-trust-surface)
6. [See It Work](#6-see-it-work)
7. [Install](#7-install)
8. [Upload Contract](#8-upload-contract)
9. [S3 Key Strategy](#9-s3-key-strategy)
10. [Asset Lifecycle](#10-asset-lifecycle)
11. [Avatar Flow](#11-avatar-flow)
12. [AI Asset Flow](#12-ai-asset-flow)
13. [Cleanup and Deletion](#13-cleanup-and-deletion)
14. [API Surface](#14-api-surface)
15. [Health and Readiness](#15-health-and-readiness)
16. [Project Structure](#16-project-structure)
17. [Configuration Reference](#17-configuration-reference)
18. [Development](#18-development)
19. [Testing Strategy](#19-testing-strategy)
20. [Lambda Operations](#20-lambda-operations)
21. [Security and Privacy](#21-security-and-privacy)
22. [Operational Notes](#22-operational-notes)
23. [Documentation Findings](#23-documentation-findings)
24. [FAQ](#24-faq)
25. [Ownership](#25-ownership)

## 1. Problem

Images, videos and generated assets are large, long-lived and often processed asynchronously. Sending every byte through the API Gateway or a NestJS process makes the application layer a bandwidth bottleneck. At the same time, allowing a browser to choose an arbitrary S3 key or receive long-lived AWS credentials creates an ownership and data-leak risk.

The platform needs one place to answer:

- Who may upload this asset?
- What purpose is the upload for?
- How large and what type may it be?
- Which object key and CDN URL represent the asset?
- When is an uploaded object safe to reference from a product, review or profile?
- How are old, rejected, orphaned or AI-generated objects cleaned up?

Media Service solves this with a server-controlled upload contract. The server validates the request, generates a short-lived presigned POST with a server-owned key, lets the client upload directly to S3 and then confirms or processes the asset. Product, review and user domains keep their own business records; Media owns the object lifecycle.

## 2. Service at a glance

| Attribute | Value |
| --- | --- |
| Service | media-service |
| Default port | 3004 |
| HTTP prefix | /api |
| URI version | v1 |
| Development docs | /docs |
| Liveness | /api/v1/health/live |
| Readiness | /api/v1/health/ready |
| Object storage | AWS S3 |
| Public delivery | Configured CDN URL |
| Image tooling | Sharp and Lambda processor |
| Video tooling | Dedicated Lambda processor |
| Body parser | Explicit JSON/urlencoded limit for media/AI payloads |

### Runtime responsibilities

Media Service owns:

1. Upload policy creation.
2. Safe object-key construction.
3. Asset confirmation and URL construction.
4. Avatar update coordination with Auth Service.
5. Internal AI asset upload/download.
6. Product/review cleanup within owner and purpose prefixes.
7. S3-aware readiness checks.

It does not own product state, review text, seller profile data or AI ranking/model decisions.

## 3. What it owns

| Domain boundary | Media Service owns |
| --- | --- |
| Upload authorization | Purpose, type, size, expiry and owner-scoped policy |
| Object identity | Asset ID and S3 key generation |
| Storage adapter | S3 put/list/get/delete operations |
| Public URL | CDN URL construction from controlled object keys |
| Avatar lifecycle | Confirm new avatar, update Auth profile, prune old objects |
| AI asset lifecycle | Upload, download and cleanup of generated outputs |
| Product/review cleanup | Batch deletion of assets removed after a domain transaction |
| Processing boundary | Image/video worker build and deployment scripts |

### What it does not own

| Concern | Source of truth |
| --- | --- |
| User profile/avatar field | Auth Service |
| Product media relationship | Product Service |
| Review media relationship | Product Service |
| AI job status/ranking decision | AI/Recommendation Service |
| S3 bucket policy/IAM account | AWS/deployment platform |
| Product or review authorization | Their owning domain plus trusted context |

Media stores and serves objects; a domain service decides whether an asset is part of a product, review or profile.

## 4. Architecture

~~~text
Browser / trusted service
          |
          v
     API Gateway
          |
          v
    Media Service
       /     \
      v       v
  S3 bucket  Auth Service
      |
      +--> CDN delivery
      +--> Lambda image/video processing
~~~

### Upload path

~~~text
Client -> POST media/uploads/presign
       -> validate DTO and owner/purpose
       -> create short-lived S3 POST policy
       -> return asset ID, key and form fields
Client -> uploads directly to S3
Client -> confirm/domain operation
       -> Media builds controlled URL or starts processing
~~~

### Layer responsibilities

- Presentation controllers own route mapping, DTO binding, UUID parsing and stream responses.
- Application services own upload, avatar, download and cleanup rules.
- AuthProfileClient updates the Auth profile through an internal contract.
- S3 clients are infrastructure adapters; callers never receive arbitrary bucket operations.
- Lambda code owns worker execution, while the NestJS service owns HTTP contracts and orchestration.

The service disables Express's default body parser and registers explicit JSON/urlencoded limits. This is required because internal AI asset payloads can be larger than the default parser limit.

## 5. Trust surface

<details>
<summary>What Media Service trusts and rejects</summary>

### Trusted after validation

- A user identity forwarded by the Gateway for avatar/product/review operations.
- A service-authenticated internal caller for AI assets and cleanup.
- An asset ID that matches the expected UUID format.
- A purpose from the allowed media-purpose set.
- S3 objects addressed through a server-generated owner/purpose/asset prefix.
- Auth Service's response when updating the profile through its internal endpoint.

### Never trusted directly

- An arbitrary S3 key or bucket path from a browser.
- A client-provided CDN URL as proof of ownership.
- A file extension as proof of content type.
- An asset ID without owner/purpose prefix verification.
- A cleanup request that can delete objects outside the caller's owner scope.
- An AI output request that can overwrite the original product image.

The security model is prefix-based and owner-scoped. Even an asset ID that exists elsewhere must not allow a caller to read or delete an object outside the expected owner and purpose path.

</details>

## 6. See It Work

### 6.1. Start local

~~~powershell
cd services/media-service
Copy-Item .env.example .env
npm install
npm run dev
~~~

The service expects AWS/S3 configuration for real upload behavior. Auth Service is also required for avatar confirmation.

### 6.2. Check health and readiness

~~~powershell
curl http://localhost:3004/api/v1/health/live
curl http://localhost:3004/api/v1/health/ready
~~~

Liveness checks whether the process is running. Readiness includes the media dependency checks needed by the current health module, so a live process is not automatically ready to accept upload traffic.

### 6.3. Open API documentation

Open http://localhost:3004/docs in development. Browser traffic in the platform should normally use the equivalent API Gateway route rather than calling the service directly.

### 6.4. Upload flow

~~~powershell
curl -X POST http://localhost:3001/api/v1/media/uploads/presign -H "Authorization: Bearer <keycloak-access-token>" -H "Content-Type: application/json" -d '{"fileName":"avatar.jpg","contentType":"image/jpeg","purpose":"avatar"}'
~~~

The response contains a server-generated asset ID and upload policy. The client must submit the returned fields to S3; it must not replace the key with a self-selected path.

## 7. Install

> [!IMPORTANT]
> Media Service requires an S3 bucket, AWS region, CDN base URL and runtime credentials. It also calls Auth Service for avatar updates and exposes protected internal contracts for AI/cleanup workflows. Never commit AWS credentials, internal tokens or production bucket details.

### Required dependencies

| Dependency | Why it is required |
| --- | --- |
| AWS S3 | Original and processed object storage |
| CDN | Public delivery URL for approved media |
| Auth Service | Avatar profile update and old-avatar cleanup coordination |
| API Gateway | Browser authentication and route boundary |
| Lambda/runtime worker | Optional asynchronous image/video processing |

### Local build

~~~powershell
cd services/media-service
Copy-Item .env.example .env
npm run type-check
npm run lint
npm test -- --runInBand
npm run build
npm run start
~~~

### Recovery and rollback

Rolling back application code does not delete S3 objects or restore a previous avatar automatically. Treat object cleanup, profile rollback and product/review reference repair as separate audited operations.

## 8. Upload Contract

### Request validation

The presign DTO defines the accepted file name, content type and media purpose. The service applies configured size and expiry limits before issuing a policy.

The policy should constrain:

- Exact or controlled object key.
- Expected content type.
- Maximum content length.
- Short expiration window.
- Asset metadata such as asset ID and purpose.

### Why presigned POST

Presigned POST lets the browser upload directly to S3 without receiving an AWS access key. It also lets the server constrain the destination and upload conditions. The NestJS process handles control-plane requests, not the entire file byte stream.

### Confirm is a separate trust boundary

S3 accepting bytes does not automatically mean a domain may reference the asset. Confirmation/processing checks that the object belongs to the expected owner/purpose and that the next domain operation can safely reference it.

## 9. S3 Key Strategy

### Original user uploads

The service builds keys from controlled segments such as:

~~~text
uploads/original/<purpose>/<owner-id>/<asset-id>/<safe-file-name>
~~~

### Processed assets

~~~text
media/processed/<purpose>/<owner-id>/<asset-id>/<variant>
~~~

### AI optimization outputs

~~~text
media/processed/ai_optimization/<owner-id>/<job-id>/<asset-id>/<safe-file-name>
~~~

### Key invariants

- Owner and asset IDs are normalized to safe path segments.
- File names cannot inject path separators.
- The client never supplies a final S3 key.
- AI output uses a separate prefix and cannot overwrite the original product image.
- Cleanup lists keys under known prefixes instead of accepting arbitrary delete keys.

These invariants make object access auditable and make cleanup bounded.

### Browser upload CORS

Presigned POST uploads run directly from the browser to S3, so the bucket must allow the
frontend origins and the `POST` method. Apply the shared policy in
[`docs/s3-cors.json`](./docs/s3-cors.json) with:

~~~bash
aws s3api put-bucket-cors \
  --bucket "$AWS_S3_BUCKET" \
  --cors-configuration file://services/media-service/docs/s3-cors.json \
  --region "$AWS_REGION"
~~~

The deploy IAM identity needs `s3:PutBucketCORS` for this one-time configuration. The
application runtime does not need that permission; it only needs object upload/read/delete
permissions required by Media Service.

## 10. Asset Lifecycle

~~~text
requested -> policy issued -> uploaded -> confirmed -> processed/published
                                 |             |
                                 v             v
                              expired       cleanup
~~~

### State responsibilities

| Stage | Responsibility |
| --- | --- |
| Requested | Validate actor, purpose, file type and size |
| Policy issued | Return a short-lived S3 upload form |
| Uploaded | S3 holds bytes under a server-owned key |
| Confirmed | Verify expected object and produce domain-safe response |
| Processed | Create resized/optimized variants when required |
| Published | Domain service references the approved URL/asset |
| Cleanup | Delete removed, rejected, expired or obsolete objects |

An uploaded object can become orphaned when a browser abandons a form or a domain transaction rolls back. Cleanup must therefore be idempotent and purpose-scoped.

## 11. Avatar Flow

~~~text
User requests avatar presign
       -> upload original to S3
       -> image processor creates medium.webp
       -> POST avatar/:assetId/confirm
       -> Media builds CDN URL
       -> Auth Service updates avatar field
       -> Media prunes older avatar objects
~~~

### Important ordering

The new profile URL is written before old assets are cleaned. If old-object cleanup fails, the new avatar remains valid and the failure is logged for reconciliation. Cleanup must never roll the profile back to a broken old URL simply because deletion had a partial failure.

### Ownership

Avatar keys are scoped under the normalized user ID. Delete-all keeps the current asset when one is supplied and removes sibling/orphan avatar objects under that user's known prefixes.

## 12. AI Asset Flow

~~~text
AI Worker -> internal AI upload
          -> Media writes output under ai_optimization prefix
AI Worker -> internal asset download by owner + asset ID
AI Service -> Product workflow applies or rejects output
AI Worker/retention -> internal job cleanup
~~~

The internal AI upload accepts controlled payload metadata and stores output in a dedicated prefix. Download resolves by owner and asset ID rather than accepting a URL from the worker. Cleanup by job removes generated outputs only; it does not remove the original product image.

Media Service owns the storage boundary, not the AI decision about whether an output is good enough to apply.

## 13. Cleanup and Deletion

### Product/review cleanup

Product and review cleanup requests contain asset IDs and purposes, not arbitrary S3 keys. The service expands each asset into known original/processed prefixes and deletes in S3-sized batches.

### Idempotency

- Repeating cleanup for an already-deleted asset returns a safe zero/empty result.
- Duplicate asset entries are de-duplicated before list/delete.
- Delete operations are bounded by the owner and purpose prefix.
- Partial S3 failures are surfaced and logged instead of being reported as a complete success.
- Cleanup occurs after the owning domain transaction has committed.

### Deletion safety

Never delete an object merely because its ID appears in a client payload. Resolve the caller identity, derive the expected prefixes and preserve any asset still referenced by the domain owner.

## 14. API Surface

All application routes, including health, use /api/v1.

### Upload and avatar

| Method | Route | Purpose |
| --- | --- | --- |
| POST | /api/v1/media/uploads/presign | Create a controlled S3 upload form |
| POST | /api/v1/media/assets/avatar/:assetId/confirm | Confirm processed avatar and update Auth |
| DELETE | /api/v1/media/assets/avatar | Remove old avatar objects while preserving current state as required |
| DELETE | /api/v1/media/assets/avatar/:assetId | Delete an owned avatar asset |

### Internal and domain cleanup

| Method | Route | Purpose |
| --- | --- | --- |
| POST | /api/v1/media/assets/internal/ai-assets/upload | Upload an AI-generated output |
| GET | /api/v1/media/assets/internal/assets/:assetId/download | Download an owner-scoped source/output |
| POST | /api/v1/media/assets/internal/ai-assets/:jobId/cleanup | Remove AI outputs for a job |
| POST | /api/v1/media/assets/product/cleanup | Delete removed product assets |
| POST | /api/v1/media/assets/review/cleanup | Delete removed review assets |

### Health

| Method | Route | Purpose |
| --- | --- | --- |
| GET | /api/v1/health/live | Process liveness |
| GET | /api/v1/health/ready | Storage/readiness state |

Internal routes require service authentication and should not be made browser-facing through an unprotected reverse proxy.

## 15. Health and Readiness

### Liveness

Liveness answers whether the Node process and HTTP listener are alive. It should stay lightweight and should not be used as proof that S3 upload is possible.

### Readiness

Readiness uses the media health indicator to check the configured storage dependency and required runtime settings. A missing bucket or invalid storage configuration should make readiness fail clearly rather than allowing an upload policy that cannot complete.

### Operational interpretation

| Result | Meaning |
| --- | --- |
| Live healthy, ready healthy | Process can accept expected media traffic |
| Live healthy, ready unhealthy | Process exists but storage/config dependency needs repair |
| Live unhealthy | Restart/replace the instance |

## 16. Project Structure

~~~text
src/
├── main.ts                              # Body limits, validation, versioning, Swagger
├── app.module.ts                        # Runtime composition
├── modules/
│   ├── health/
│   │   ├── health.controller.ts         # Live/readiness endpoints
│   │   └── indicators/                  # S3-aware health indicator
│   └── media/
│       ├── application/
│       │   ├── clients/                 # Auth profile client
│       │   ├── constants/               # Allowed upload purposes
│       │   ├── services/                # Upload, asset and avatar use cases
│       │   └── types/                   # Media/AI upload contracts
│       ├── presentation/
│       │   ├── controllers/             # Upload and asset routes
│       │   └── dto/                     # Presign, AI and cleanup DTOs
│       └── media.module.ts
lambda/
├── image-processor/                     # Image processing handler
└── video-processor/                     # Video processing handler
scripts/lambda/                          # Build, deploy, configure and verify
~~~

The HTTP application and Lambda workers share media concepts but have separate runtime boundaries. Keep worker-specific assumptions out of public controllers.

## 17. Configuration Reference

### Runtime and internal integration

| Variable | Purpose | Example |
| --- | --- | --- |
| NODE_ENV | Runtime mode and docs behavior | development |
| PORT | HTTP listener | 3004 |
| AUTH_SERVICE_URL | Auth internal profile endpoint | http://localhost:3002 |
| INTERNAL_SERVICE_TOKEN | Trusted service token | deployment secret |

### Storage and delivery

| Variable | Purpose | Example |
| --- | --- | --- |
| AWS_REGION | S3 region | ap-southeast-1 |
| AWS_S3_BUCKET | Media bucket | bin-ecommerce-media-dev |
| MEDIA_PUBLIC_CDN_URL | Public asset base URL | https://cdn.example.com |

### Upload policy

| Variable | Purpose | Example |
| --- | --- | --- |
| MEDIA_REQUEST_BODY_LIMIT | JSON/urlencoded body limit | 12mb |
| MEDIA_UPLOAD_EXPIRES_SECONDS | Presigned policy lifetime | 300 |
| MEDIA_MAX_UPLOAD_SIZE_BYTES | Maximum upload size | 5242880 |

Use [.env.example](./.env.example) as the local variable template. In production, prefer IAM roles and secret-manager injection over static AWS credentials.

## 18. Development

### Commands

| Command | Purpose |
| --- | --- |
| npm run dev | Start Nest watch mode |
| npm run build | Build the HTTP service |
| npm run start | Run the built service |
| npm run type-check | Check HTTP and Lambda TypeScript |
| npm run lint | Lint src and Lambda code |
| npm test | Run Jest tests |
| npm run build:lambda | Compile Lambda handlers |

### Recommended local gate

~~~powershell
npm run type-check
npm run lint
npm test -- --runInBand
npm run build
npm run build:lambda
~~~

For manual upload testing, use a development S3 bucket or LocalStack-style substitute with a short-lived test policy. Do not use a production bucket to test cleanup.

## 19. Testing Strategy

### Unit tests

Cover:

- Allowed purpose validation.
- File type and size limits.
- Server-controlled key construction.
- Safe path-segment normalization.
- Presigned policy expiry and conditions.
- Avatar confirmation and Auth profile update ordering.
- Owner-scoped avatar pruning.
- AI output prefix isolation.
- Internal download owner/purpose lookup.
- Product/review cleanup de-duplication and batching.
- Partial S3 delete failure behavior.

### Integration tests

Use an isolated S3-compatible test environment and Auth Service test double to verify:

- Presigned POST fields and restrictions.
- Upload/confirm behavior.
- CDN URL construction.
- Avatar profile update plus old-object cleanup.
- Internal AI upload/download.
- Product/review cleanup prefixes.
- Liveness/readiness when storage is unavailable.

### Acceptance flow

~~~text
Given an authenticated owner and an allowed image purpose
When the client requests a presigned upload
Then the policy contains a server-owned key and an expiry
When the client uploads to S3 and confirms the asset
Then the response contains a controlled asset/CDN reference
When the owner replaces an avatar
Then Auth points to the new avatar before old objects are pruned
When an AI job is rejected
Then only that job's generated outputs are cleaned
~~~

## 20. Lambda Operations

| Command | Purpose |
| --- | --- |
| npm run lambda:build | Build image processor |
| npm run lambda:deploy | Deploy image processor |
| npm run lambda:verify | Verify image processor |
| npm run lambda:verify-pipeline | Verify image event pipeline |
| npm run lambda:video:build | Build video processor |
| npm run lambda:video:deploy | Deploy video processor |
| npm run lambda:video:configure | Configure video pipeline |

### Worker release checklist

1. Build the correct Lambda target.
2. Verify the generated artifact and runtime handler.
3. Confirm bucket/prefix permissions are least-privilege.
4. Test one representative image/video input.
5. Verify output key and content type.
6. Confirm failed processing does not replace the source object.
7. Observe duration, memory and error metrics after release.

## 21. Security and Privacy

- Never return AWS credentials to the browser.
- Keep presigned expiry short and policy scope narrow.
- Do not accept arbitrary S3 keys, bucket names or CDN URLs from callers.
- Validate UUIDs and normalize every path segment.
- Keep internal AI/download/cleanup routes behind the shared service guard.
- Do not log file bytes, signed fields, AWS secrets or private asset URLs.
- Treat avatars, reviews and product media as user/customer data.
- Delete only owner-scoped, purpose-scoped prefixes.
- Use least-privilege IAM permissions for S3 and Lambda.
- Keep public CDN policy separate from write/delete permissions.

The Gateway protects public admission, while Media Service independently protects its internal contracts and storage operations. Both layers are required for defense in depth.

## 22. Operational Notes

### Dependency health

Monitor S3 request failures, presigned-policy expiry, upload size rejection, CDN 4xx/5xx, Lambda duration/error rate, orphan object growth and Auth Service avatar update failures.

### Failure matrix

| Failure | Expected behavior |
| --- | --- |
| S3 unavailable | Readiness or media operation fails clearly; no fake URL |
| Missing bucket | Readiness fails and upload is rejected |
| Presigned policy expired | S3 rejects upload; client requests a new policy |
| Auth update fails | New avatar must not be reported as fully confirmed |
| Old cleanup fails | Keep the new avatar; record cleanup failure for reconciliation |
| AI output rejected | Clean generated prefix only, preserve source |
| Partial batch delete | Surface failure and retry safely |
| Lambda processing fails | Preserve original object and mark processing failure through worker contract |

### Deployment checklist

1. Verify AWS region, bucket and IAM permissions.
2. Verify CDN base URL does not point to the wrong environment.
3. Verify Auth Service URL and internal token.
4. Check liveness and readiness.
5. Run a non-production presign/upload/confirm flow.
6. Test cleanup in an isolated prefix.
7. Deploy/verify image and video workers independently.

## 23. Documentation Findings

The following facts should be verified in deployment:

1. Media Service uses port 3004 in the current environment template and body parsing is explicitly configured with a 12 MB default limit.
2. The configured maximum upload size is 5 MB, which is separate from the request body limit used for JSON/AI payloads.
3. The service relies on AWS S3 and a CDN URL but does not own a media relational database in the current source layout.
4. Avatar confirmation updates Auth Service before old-object cleanup; cleanup failure should not make the new profile URL invalid.
5. AI outputs use a separate ai_optimization prefix and the cleanup route is intentionally prevented from deleting the original product image.
6. Product and review cleanup should be called after the owning domain transaction commits.

This section records source behavior and operational checks. It does not change AWS, CDN or deployment configuration.

## 24. FAQ

### Why does the client upload directly to S3?

To keep large file bytes out of the API process while preserving server control over key, purpose, size and expiry.

### Is a CDN URL enough to prove ownership?

No. The URL is a delivery reference. Ownership is established by the server-generated key, authenticated context and domain relationship.

### Can a client choose an S3 key?

No. The server constructs the key from controlled owner, purpose and asset segments.

### What happens if a user abandons an upload?

The object may become orphaned under a bounded prefix. Retention/cleanup can remove it without allowing arbitrary bucket deletion.

### Does Media Service update the user profile?

Avatar confirmation calls Auth Service's internal profile contract. Auth Service remains the owner of the user avatar field.

### Does rejecting an AI result delete the original product image?

No. AI outputs live under a separate prefix and cleanup is scoped to the AI job.

### Can the service run without AWS locally?

The process can be bootstrapped only if the health/configuration requirements permit it, but real upload/readiness tests need an S3-compatible dependency or a development bucket.

## 25. Ownership

### Engineering

**Đào Ngọc Anh**

**Software Engineer**

[View portfolio](https://daongocanh.site)

Software Engineer responsible for the architecture, implementation, integration, and maintenance of this service.

### Architecture & API Design

**Đào Ngọc Anh**

Designed the controlled upload boundary, S3/CDN integration, owner-scoped key strategy, avatar lifecycle, AI asset isolation, cleanup contracts, and Lambda processing workflow.
