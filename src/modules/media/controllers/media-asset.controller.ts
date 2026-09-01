import {
  Controller,
  Body,
  Delete,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
  ForbiddenException,
  Get,
  StreamableFile,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { AvatarService } from "../services/avatar.service";
import { MediaAssetService } from "../services/media-asset.service";
import { CleanupProductAssetsDto } from "../dto/cleanup-product-assets.dto";
import { CleanupReviewAssetsDto } from "../dto/cleanup-review-assets.dto";
import { AiAssetUploadDto } from "../dto/ai-asset-upload.dto";
import type { AiAssetUploadResponse } from "../types/ai-asset-upload.type";
import type {
  CleanupProductAssetsResponse,
  ConfirmAvatarResponse,
  DeleteMediaAssetResponse,
} from "../types/media-upload.type";

// Controller để xử lý các request liên quan đến media assets
@ApiTags("media assets")
@Controller("media/assets")
export class MediaAssetController {
  // Nhận MediaAssetService qua dependency injection để controller chỉ xử lý HTTP contract và user context.
  constructor(
    private readonly mediaAssetService: MediaAssetService,
    private readonly avatarService: AvatarService,
    private readonly config: ConfigService,
  ) {}

  // Chi cho phep service token noi bo upload output AI, khong mo endpoint nay cho browser seller.
  @Post("internal/ai-assets/upload")
  @HttpCode(HttpStatus.CREATED)
  uploadAiAsset(
    @Headers("x-internal-service-token") serviceToken: string | undefined,
    @Body() dto: AiAssetUploadDto,
  ): Promise<AiAssetUploadResponse> {
    const expected = this.config.get<string>("INTERNAL_SERVICE_TOKEN");
    if (!expected || serviceToken !== expected) throw new ForbiddenException("Internal service authentication required");
    return this.mediaAssetService.uploadAiAsset(dto);
  }

  // Endpoint noi bo cho AI Worker tai source theo asset ID, khong cho frontend truyen URL tuy y.
  @Get("internal/assets/:assetId/download")
  downloadInternalAsset(
    @Headers("x-internal-service-token") serviceToken: string | undefined,
    @Headers("x-user-id") ownerId: string | undefined,
    @Param("assetId", new ParseUUIDPipe({ version: "4" })) assetId: string,
    @Query("purpose") purpose: "product_image" | "ai_optimization" = "product_image",
  ): Promise<StreamableFile> {
    const expected = this.config.get<string>("INTERNAL_SERVICE_TOKEN");
    if (!expected || serviceToken !== expected) throw new ForbiddenException("Internal service authentication required");
    if (!ownerId || !["product_image", "ai_optimization"].includes(purpose)) {
      throw new UnauthorizedException("Invalid internal media context");
    }
    return this.mediaAssetService.downloadInternalAsset(ownerId, assetId, purpose).then((asset) => new StreamableFile(asset.body, {
      type: asset.contentType,
      disposition: `inline; filename="${asset.fileName.replace(/[^a-zA-Z0-9._-]/g, "-")}"`,
    }));
  }

  // Endpoint cleanup output AI theo job sau reject/retention, khong xoa source product image.
  @Post("internal/ai-assets/:jobId/cleanup")
  @HttpCode(HttpStatus.OK)
  cleanupAiAssets(
    @Headers("x-internal-service-token") serviceToken: string | undefined,
    @Headers("x-user-id") ownerId: string | undefined,
    @Param("jobId", new ParseUUIDPipe({ version: "4" })) jobId: string,
  ): Promise<{ deletedCount: number }> {
    const expected = this.config.get<string>("INTERNAL_SERVICE_TOKEN");
    if (!expected || serviceToken !== expected) throw new ForbiddenException("Internal service authentication required");
    if (!ownerId) throw new UnauthorizedException("Missing internal media context");
    return this.mediaAssetService.cleanupAiOutputs(ownerId, jobId).then((deletedCount) => ({ deletedCount }));
  }

  // Xóa asset sản phẩm sau khi transaction cập nhật product đã commit; media service tự giới hạn trong prefix của user.
  @Post("product/cleanup")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete removed product media assets" })
  cleanupProductAssets(
    @Headers("x-user-id") userId: string | undefined,
    @Body() dto: CleanupProductAssetsDto,
  ): Promise<CleanupProductAssetsResponse> {
    if (!userId) {
      throw new UnauthorizedException("Missing authenticated user context");
    }

    return this.mediaAssetService.cleanupProductAssets(userId, dto.assets);
  }

  // Cleanup review chỉ nhận asset ID/purpose và dùng internal token để Product Service không thể xóa ngoài owner scope.
  @Post("review/cleanup")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete removed review media assets" })
  cleanupReviewAssets(
    @Headers("x-internal-service-token") serviceToken: string | undefined,
    @Headers("x-user-id") userId: string | undefined,
    @Body() dto: CleanupReviewAssetsDto,
  ): Promise<CleanupProductAssetsResponse> {
    const expected = this.config.get<string>("INTERNAL_SERVICE_TOKEN");
    if (!expected || serviceToken !== expected) {
      throw new ForbiddenException("Internal service authentication required");
    }
    if (!userId) {
      throw new UnauthorizedException("Missing authenticated user context");
    }

    return this.mediaAssetService.cleanupReviewAssets(userId, dto.assets);
  }

  // Xác nhận asset mới sau khi upload để backend tự cập nhật hồ sơ và dọn avatar cũ trong một request.
  @Post("avatar/:assetId/confirm")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Confirm a processed avatar" })
  confirmAvatar(
    @Headers("x-user-id") userId: string | undefined,
    @Param("assetId", new ParseUUIDPipe({ version: "4" })) assetId: string,
  ): Promise<ConfirmAvatarResponse> {
    if (!userId) {
      throw new UnauthorizedException("Missing authenticated user context");
    }

    return this.avatarService.confirmAvatar(userId, assetId);
  }

  // Giữ lại avatar hiện tại và dọn toàn bộ asset avatar cũ của user để xử lý cả dữ liệu orphan từ các lần trước.
  @Delete("avatar")
  @ApiOperation({ summary: "Delete all old avatar assets" })
  pruneAvatarAssets(
    @Headers("x-user-id") userId: string | undefined,
    @Query("keepAssetId", new ParseUUIDPipe({ version: "4" }))
    keepAssetId: string,
  ): Promise<DeleteMediaAssetResponse> {
    if (!userId) {
      throw new UnauthorizedException("Missing authenticated user context");
    }

    return this.mediaAssetService.pruneAvatarAssets(userId, keepAssetId);
  }

  // Xóa toàn bộ object thuộc avatar cũ nhưng chỉ trong prefix của chính user đang đăng nhập.
  @Delete("avatar/:assetId")
  @ApiOperation({ summary: "Delete an old avatar asset" })
  deleteAvatarAsset(
    @Headers("x-user-id") userId: string | undefined,
    @Param("assetId", new ParseUUIDPipe({ version: "4" })) assetId: string,
  ): Promise<DeleteMediaAssetResponse> {
    if (!userId) {
      throw new UnauthorizedException("Missing authenticated user context");
    }

    return this.mediaAssetService.deleteAvatarAsset(userId, assetId);
  }
}
