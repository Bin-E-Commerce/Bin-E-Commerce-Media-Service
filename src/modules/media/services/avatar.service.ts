import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ConfirmAvatarResponse } from "../types/media-upload.type";
import { AuthProfileClient } from "./auth-profile.client";
import { MediaAssetService } from "./media-asset.service";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);
  private readonly bucket: string;
  private readonly publicBaseUrl: string;
  private readonly s3: S3Client;

  // Khởi tạo các dependency cần cho bước xác nhận, cập nhật hồ sơ và dọn avatar cũ.
  constructor(
    private readonly configService: ConfigService,
    private readonly authProfileClient: AuthProfileClient,
    private readonly mediaAssetService: MediaAssetService,
  ) {
    const region = this.configService.get<string>(
      "AWS_REGION",
      "ap-southeast-1",
    );
    this.bucket = this.configService.get<string>("AWS_S3_BUCKET", "");
    this.publicBaseUrl = this.configService
      .get<string>("MEDIA_PUBLIC_CDN_URL", "")
      .replace(/\/$/, "");
    this.s3 = new S3Client({ region });
  }

  // Xác nhận ảnh resize đã sẵn sàng, cập nhật URL ở Auth Service rồi dọn asset cũ mà không làm hỏng avatar mới.
  async confirmAvatar(
    userId: string,
    assetId: string,
  ): Promise<ConfirmAvatarResponse> {
    this.ensureConfigured();

    const safeUserId = this.toSafePathSegment(userId);
    const mediumKey = `media/processed/avatar/${safeUserId}/${assetId}/medium.webp`;

    await this.ensureProcessedImageExists(mediumKey);

    const avatarUrl = `${this.publicBaseUrl}/${mediumKey}`;
    const { user, oldAvatarUrl } = await this.authProfileClient.updateAvatar(
      userId,
      avatarUrl,
    );
    const oldAssetId = this.extractManagedAvatarAssetId(
      oldAvatarUrl,
      safeUserId,
    );

    if (!oldAssetId || oldAssetId === assetId) {
      return {
        assetId,
        avatarUrl,
        user,
        cleanup: {
          status: "skipped",
          oldAssetId: oldAssetId ?? null,
          deletedCount: 0,
        },
      };
    }

    // URL mới đã được lưu thành công nên lỗi cleanup chỉ được ghi nhận, không rollback hồ sơ về ảnh cũ.
    try {
      const cleanupResult = await this.mediaAssetService.deleteAvatarAsset(
        userId,
        oldAssetId,
      );

      return {
        assetId,
        avatarUrl,
        user,
        cleanup: {
          status: "deleted",
          oldAssetId,
          deletedCount: cleanupResult.deletedCount,
        },
      };
    } catch (error) {
      this.logger.warn(
        `Avatar updated but old asset ${oldAssetId} cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return {
        assetId,
        avatarUrl,
        user,
        cleanup: {
          status: "deferred",
          oldAssetId,
          deletedCount: 0,
        },
      };
    }
  }

  // Dừng sớm nếu service thiếu bucket hoặc CloudFront URL để không lưu đường dẫn avatar không hợp lệ.
  private ensureConfigured(): void {
    if (!this.bucket) {
      throw new ServiceUnavailableException("AWS_S3_BUCKET is not configured");
    }

    if (!this.publicBaseUrl) {
      throw new ServiceUnavailableException(
        "MEDIA_PUBLIC_CDN_URL is not configured",
      );
    }
  }

  // Kiểm tra trực tiếp trên S3 để chỉ cập nhật hồ sơ sau khi Lambda đã tạo medium.webp thành công.
  private async ensureProcessedImageExists(mediumKey: string): Promise<void> {
    try {
      await this.s3.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: mediumKey,
        }),
      );
    } catch {
      throw new ConflictException(
        "Avatar is still being processed. Please try again shortly.",
      );
    }
  }

  // Đọc assetId từ URL do hệ thống quản lý và chỉ chấp nhận đường dẫn thuộc đúng user đang cập nhật.
  private extractManagedAvatarAssetId(
    avatarUrl: string | null,
    safeUserId: string,
  ): string | null {
    if (!avatarUrl) return null;

    try {
      const parts = new URL(avatarUrl).pathname
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
      const isProcessedPath =
        parts[0] === "media" &&
        parts[1] === "processed" &&
        parts[2] === "avatar";
      const isOriginalPath =
        parts[0] === "uploads" &&
        parts[1] === "original" &&
        parts[2] === "avatar";

      if ((!isProcessedPath && !isOriginalPath) || parts[3] !== safeUserId) {
        return null;
      }

      const assetId = parts[4];
      return assetId && UUID_V4_PATTERN.test(assetId) ? assetId : null;
    } catch {
      return null;
    }
  }

  // Chuẩn hóa user ID giống quy tắc tạo S3 key để bước confirm chỉ kiểm tra đúng folder của chủ sở hữu.
  private toSafePathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
  }
}
