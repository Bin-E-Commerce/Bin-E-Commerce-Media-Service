import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  CleanupProductAssetsResponse,
  DeleteMediaAssetResponse,
  ProductMediaCleanupAsset,
} from "../types/media-upload.type";
import type { AiAssetUploadResponse } from "../types/ai-asset-upload.type";
import type { AiAssetUploadDto } from "../dto/ai-asset-upload.dto";

const S3_DELETE_BATCH_SIZE = 1000;

@Injectable()
export class MediaAssetService {
  private readonly logger = new Logger(MediaAssetService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  // Khởi tạo S3 client và đọc bucket một lần để các thao tác lifecycle dùng chung cấu hình.
  constructor(private readonly configService: ConfigService) {
    const region = this.configService.get<string>("AWS_REGION", "ap-southeast-1");
    this.bucket = this.configService.get<string>("AWS_S3_BUCKET", "");
    this.s3 = new S3Client({ region });
  }

  // Luu output AI vao prefix rieng, khong chen vao upload user va khong ghi de asset goc.
  async uploadAiAsset(dto: AiAssetUploadDto): Promise<AiAssetUploadResponse> {
    if (!this.bucket) throw new ServiceUnavailableException("AWS_S3_BUCKET is not configured");
    const allowedContentTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedContentTypes.includes(dto.contentType)) throw new ServiceUnavailableException("Unsupported AI image type");
    const assetId = randomUUID();
    const safeOwnerId = this.toSafePathSegment(dto.sellerOwnerId);
    const safeJobId = this.toSafePathSegment(dto.jobId);
    const safeFileName = this.toSafeFileBaseName(dto.fileName);
    const objectKey = `media/processed/ai_optimization/${safeOwnerId}/${safeJobId}/${assetId}/${safeFileName}`;
    const body = Buffer.from(dto.contentBase64, "base64");
    if (body.length > 8 * 1024 * 1024) throw new ServiceUnavailableException("AI image is too large");
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, Body: body, ContentType: dto.contentType, Metadata: { "asset-id": assetId, "owner-id": dto.sellerOwnerId, purpose: "ai_optimization", "job-id": dto.jobId } }));
    const publicBaseUrl = this.configService.get<string>("MEDIA_PUBLIC_CDN_URL", "").replace(/\/$/, "");
    return { assetId, objectKey, publicUrl: publicBaseUrl ? `${publicBaseUrl}/${objectKey}` : null };
  }

  // Doc byte anh goc qua service token; worker khong duoc tu truy cap S3 va khong nhan URL tu seller.
  async downloadInternalAsset(
    ownerId: string,
    assetId: string,
    purpose: "product_image" | "ai_optimization",
  ): Promise<{ body: Buffer; contentType: string; fileName: string }> {
    if (!this.bucket) throw new ServiceUnavailableException("AWS_S3_BUCKET is not configured");
    const prefix = `uploads/original/${purpose}/${this.toSafePathSegment(ownerId)}/${this.toSafePathSegment(assetId)}/`;
    const keys = await this.listObjectKeys(prefix);
    // Sau khi apply, product có thể tham chiếu asset AI cũ. Tìm trong prefix AI cùng owner
    // để hỗ trợ tái tối ưu dữ liệu legacy mà chưa có sourceAssetId; không bao giờ quét ngoài owner.
    const objectKey = keys[0] ?? (purpose === "product_image"
      ? await this.findProcessedAiAssetKey(ownerId, assetId)
      : undefined);
    if (!objectKey) throw new ServiceUnavailableException("Source media asset is unavailable");
    const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    if (!response.Body) throw new ServiceUnavailableException("Source media asset is unavailable");
    const body = Buffer.from(await response.Body.transformToByteArray());
    return {
      body,
      contentType: response.ContentType ?? "application/octet-stream",
      fileName: objectKey.split("/").pop() ?? "source-image",
    };
  }

  // Tìm đúng asset AI theo path segment, tránh match nhầm asset có ID chỉ là một phần chuỗi.
  private async findProcessedAiAssetKey(ownerId: string, assetId: string): Promise<string | undefined> {
    const ownerPrefix = `media/processed/ai_optimization/${this.toSafePathSegment(ownerId)}/`;
    const assetSegment = `/${this.toSafePathSegment(assetId)}/`;
    const keys = await this.listObjectKeys(ownerPrefix);
    return keys.find((key) => key.includes(assetSegment));
  }

  // Xoa output theo prefix job, chi duoc goi boi service token va khong cham vao asset goc product.
  async cleanupAiOutputs(ownerId: string, jobId: string): Promise<number> {
    if (!this.bucket) throw new ServiceUnavailableException("AWS_S3_BUCKET is not configured");
    const prefix = `media/processed/ai_optimization/${this.toSafePathSegment(ownerId)}/${this.toSafePathSegment(jobId)}/`;
    const objectKeys = await this.listObjectKeys(prefix);
    if (objectKeys.length > 0) await this.deleteObjectKeys(objectKeys);
    return objectKeys.length;
  }

  // Dọn mọi avatar cũ của user và giữ nguyên asset hiện tại để tự khắc phục cả những lần cleanup trước bị bỏ sót.
  async pruneAvatarAssets(
    userId: string,
    keepAssetId: string,
  ): Promise<DeleteMediaAssetResponse> {
    if (!this.bucket) {
      throw new ServiceUnavailableException("AWS_S3_BUCKET is not configured");
    }

    const safeUserId = this.toSafePathSegment(userId);
    const rootPrefixes = [
      `uploads/original/avatar/${safeUserId}/`,
      `media/processed/avatar/${safeUserId}/`,
    ];
    const keyGroups = await Promise.all(
      rootPrefixes.map((prefix) => this.listObjectKeys(prefix)),
    );

    // Chỉ giữ key nằm đúng dưới folder keepAssetId; mọi asset sibling khác đều là avatar cũ hoặc orphan.
    const objectKeysToDelete = keyGroups
      .flat()
      .filter((key) => !key.includes(`/${keepAssetId}/`));

    if (objectKeysToDelete.length === 0) {
      return { assetId: keepAssetId, deletedCount: 0 };
    }

    await this.deleteObjectKeys(objectKeysToDelete);
    this.logger.log(
      `Pruned ${objectKeysToDelete.length} old avatar objects; kept asset ${keepAssetId}`,
    );

    return {
      assetId: keepAssetId,
      deletedCount: objectKeysToDelete.length,
    };
  }

  // Xóa ảnh gốc và toàn bộ biến thể resize của một avatar; gọi lặp lại vẫn an toàn và trả deletedCount bằng 0.
  async deleteAvatarAsset(
    userId: string,
    assetId: string,
  ): Promise<DeleteMediaAssetResponse> {
    if (!this.bucket) {
      throw new ServiceUnavailableException("AWS_S3_BUCKET is not configured");
    }

    const safeUserId = this.toSafePathSegment(userId);
    const originalPrefix = `uploads/original/avatar/${safeUserId}/${assetId}/`;
    const processedPrefix = `media/processed/avatar/${safeUserId}/${assetId}`;
    const originalKeys = await this.listObjectKeys(originalPrefix);

    // Ba key processed có tên cố định nên xóa trực tiếp; chỉ cần list một lần để tìm tên file gốc.
    const objectKeys = [
      ...originalKeys,
      `${processedPrefix}/thumb.webp`,
      `${processedPrefix}/medium.webp`,
      `${processedPrefix}/large.webp`,
    ];

    await this.deleteObjectKeys(objectKeys);
    this.logger.log(
      `Deleted ${objectKeys.length} objects for avatar asset ${assetId}`,
    );

    return {
      assetId,
      deletedCount: objectKeys.length,
    };
  }

  // Xóa cả object gốc và mọi biến thể đã xử lý của các asset bị loại khỏi product, theo batch để giảm số lần gọi S3.
  async cleanupProductAssets(
    userId: string,
    assets: ProductMediaCleanupAsset[],
  ): Promise<CleanupProductAssetsResponse> {
    if (!this.bucket) {
      throw new ServiceUnavailableException("AWS_S3_BUCKET is not configured");
    }

    const safeUserId = this.toSafePathSegment(userId);
    const uniqueAssets = Array.from(
      new Map(assets.map((asset) => [`${asset.purpose}:${asset.assetId}`, asset])).values(),
    );
    const prefixes = uniqueAssets.flatMap((asset) => [
      `uploads/original/${asset.purpose}/${safeUserId}/${asset.assetId}/`,
      `media/processed/${asset.purpose}/${safeUserId}/${asset.assetId}/`,
    ]);
    const keyGroups = await Promise.all(prefixes.map((prefix) => this.listObjectKeys(prefix)));
    const objectKeys = [...new Set(keyGroups.flat())];

    if (objectKeys.length > 0) {
      await this.deleteObjectKeys(objectKeys);
    }

    this.logger.log(
      `Cleaned ${objectKeys.length} objects for ${uniqueAssets.length} product media assets`,
    );
    return {
      requestedAssetCount: uniqueAssets.length,
      deletedCount: objectKeys.length,
    };
  }

  // Lấy toàn bộ key dưới một prefix và xử lý continuation token để không bỏ sót dữ liệu khi số object lớn.
  private async listObjectKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const object of response.Contents ?? []) {
        if (object.Key) keys.push(object.Key);
      }

      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);

    return keys;
  }

  // Chia key theo giới hạn 1000 object của S3 DeleteObjects và fail rõ ràng nếu AWS trả lỗi từng object.
  private async deleteObjectKeys(objectKeys: string[]): Promise<void> {
    for (
      let startIndex = 0;
      startIndex < objectKeys.length;
      startIndex += S3_DELETE_BATCH_SIZE
    ) {
      const batch = objectKeys.slice(
        startIndex,
        startIndex + S3_DELETE_BATCH_SIZE,
      );
      const response = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: batch.map((key) => ({ Key: key })),
            Quiet: true,
          },
        }),
      );

      if ((response.Errors?.length ?? 0) > 0) {
        this.logger.error("Failed to delete some S3 avatar objects", {
          errors: response.Errors,
        });
        throw new ServiceUnavailableException(
          "Unable to delete all avatar objects",
        );
      }
    }
  }

  // Chuẩn hóa user ID thành path segment an toàn giống quy tắc tạo upload key.
  private toSafePathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
  }

  // Rut gon ten file ve path segment an toan de AI worker khong the chen dau / vao S3 key.
  private toSafeFileBaseName(value: string): string {
    return value.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "ai-output";
  }
}
