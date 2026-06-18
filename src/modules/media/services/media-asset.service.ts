import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DeleteMediaAssetResponse } from "../types/media-upload.type";

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
}
