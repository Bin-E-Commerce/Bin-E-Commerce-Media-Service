import { randomUUID } from "crypto";
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import {
  MEDIA_IMAGE_UPLOAD_MIME_TYPES,
  MEDIA_IMAGE_UPLOAD_PURPOSES,
  MEDIA_MAX_IMAGE_UPLOAD_SIZE_BYTES,
  MEDIA_MAX_VIDEO_UPLOAD_SIZE_BYTES,
  MEDIA_UPLOAD_EXTENSION_BY_MIME_TYPE,
  MEDIA_VIDEO_UPLOAD_MIME_TYPES,
  MEDIA_VIDEO_UPLOAD_PURPOSES,
} from "../constants/media-upload.constant";
import { CreatePresignedUploadDto } from "../../presentation/dto/create-presigned-upload.dto";
import type { PresignedUploadResponse } from "../types/media-upload.type";

@Injectable()
export class MediaUploadService {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly expiresIn: number;
  private readonly maxImageUploadSize: number;
  private readonly maxVideoUploadSize: number;
  private readonly publicBaseUrl: string | null;

  // Khởi tạo S3 client và đọc cấu hình upload một lần để mọi request dùng cùng policy.
  constructor(private readonly configService: ConfigService) {
    const region = this.configService.get<string>(
      "AWS_REGION",
      "ap-southeast-1",
    );
    this.bucket = this.configService.get<string>("AWS_S3_BUCKET", "");
    this.expiresIn = this.configService.get<number>(
      "MEDIA_UPLOAD_EXPIRES_SECONDS", // Thời gian hiệu lực của presigned URL, sau đó URL sẽ không còn hợp lệ để upload nữa. Mặc định là 5 phút để giảm rủi ro lộ URL.
      300,
    );
    this.maxImageUploadSize = this.configService.get<number>(
      "MEDIA_MAX_UPLOAD_SIZE_BYTES", // Kích thước tối đa của file được phép upload. Mặc định là 5MB.
      MEDIA_MAX_IMAGE_UPLOAD_SIZE_BYTES,
    );
    this.maxVideoUploadSize = this.configService.get<number>(
      "MEDIA_MAX_VIDEO_UPLOAD_SIZE_BYTES",
      MEDIA_MAX_VIDEO_UPLOAD_SIZE_BYTES,
    );
    this.publicBaseUrl =
      this.configService.get<string>("MEDIA_PUBLIC_CDN_URL") ?? null;
    this.s3 = new S3Client({ region });
  }

  // Tạo presigned POST có điều kiện giới hạn content-type, dung lượng và key cố định.
  async createPresignedUpload(
    userId: string,
    dto: CreatePresignedUploadDto,
  ): Promise<PresignedUploadResponse> {
    if (!this.bucket) {
      throw new ServiceUnavailableException("AWS_S3_BUCKET is not configured");
    }
    const maxUploadSize = this.assertUploadPolicy(dto);

    const assetId = randomUUID();
    const objectKey = this.buildOriginalObjectKey(userId, assetId, dto);

    // Presigned POST dùng policy để S3 tự từ chối file quá dung lượng hoặc sai content-type.
    const upload = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: objectKey,
      Expires: this.expiresIn,
      Fields: {
        // Các trường này sẽ được gửi kèm trong form upload lên S3, S3 sẽ gắn metadata tương ứng cho object khi upload thành công.
        "Content-Type": dto.contentType,
        "x-amz-meta-asset-id": assetId,
        "x-amz-meta-owner-id": userId,
        "x-amz-meta-purpose": dto.purpose,
      },
      Conditions: [
        // Các điều kiện này sẽ được S3 kiểm tra khi nhận file upload
        ["content-length-range", 1, maxUploadSize],
        ["eq", "$Content-Type", dto.contentType],
        ["eq", "$key", objectKey],
      ],
    });

    return {
      assetId,
      objectKey,
      expiresIn: this.expiresIn,
      status: "uploading",
      upload: {
        url: upload.url,
        fields: upload.fields,
      },
      publicBaseUrl: this.publicBaseUrl,
    };
  }

  // Sinh key theo owner/purpose/asset để client không tự chọn được đường dẫn upload tùy ý.
  // Áp dụng policy riêng cho ảnh và video để video không dùng nhầm giới hạn của ảnh.
  private assertUploadPolicy(dto: CreatePresignedUploadDto): number {
    const isImagePurpose = (MEDIA_IMAGE_UPLOAD_PURPOSES as readonly string[]).includes(
      dto.purpose,
    );
    const isVideoPurpose = (MEDIA_VIDEO_UPLOAD_PURPOSES as readonly string[]).includes(
      dto.purpose,
    );

    if (!isImagePurpose && !isVideoPurpose) {
      throw new BadRequestException("Mục đích tải tệp không hợp lệ.");
    }

    const allowedMimeTypes: readonly string[] = isVideoPurpose
      ? MEDIA_VIDEO_UPLOAD_MIME_TYPES
      : MEDIA_IMAGE_UPLOAD_MIME_TYPES;
    const maxUploadSize = isVideoPurpose
      ? this.maxVideoUploadSize
      : this.maxImageUploadSize;

    if (!allowedMimeTypes.includes(dto.contentType)) {
      throw new BadRequestException(
        isVideoPurpose
          ? "Video chỉ hỗ trợ định dạng MP4 hoặc WebM."
          : "Ảnh chỉ hỗ trợ định dạng JPG, PNG hoặc WebP.",
      );
    }

    if (dto.fileSize > maxUploadSize) {
      throw new BadRequestException(
        isVideoPurpose
          ? "Video không được vượt quá 30 MB."
          : "Ảnh không được vượt quá 5 MB.",
      );
    }

    return maxUploadSize;
  }

  private buildOriginalObjectKey(
    userId: string,
    assetId: string,
    dto: CreatePresignedUploadDto,
  ): string {
    const safeUserId = this.toSafePathSegment(userId);
    const safeName = this.toSafeFileBaseName(dto.fileName);
    const extension = MEDIA_UPLOAD_EXTENSION_BY_MIME_TYPE[dto.contentType];

    return [
      "uploads",
      "original",
      dto.purpose,
      safeUserId,
      assetId,
      `${safeName}.${extension}`,
    ].join("/");
  }

  // Chuẩn hóa path segment để tránh ký tự đặc biệt làm lệch prefix hoặc gây upload nhầm vị trí.
  private toSafePathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
  }

  // Giữ tên file dễ đọc nhưng loại bỏ phần mở rộng và ký tự không phù hợp với S3 key policy.
  private toSafeFileBaseName(fileName: string): string {
    const nameWithoutExtension = fileName.replace(/\.[^.]+$/, "");
    const safeName = nameWithoutExtension
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);

    return safeName || "image";
  }
}
