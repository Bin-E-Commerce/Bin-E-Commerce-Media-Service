import {
  Controller,
  Delete,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { AvatarService } from "../services/avatar.service";
import { MediaAssetService } from "../services/media-asset.service";
import type {
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
  ) {}

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
