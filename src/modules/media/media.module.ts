import { Module } from "@nestjs/common";
import { MediaAssetController } from "./presentation/controllers/media-asset.controller";
import { MediaUploadController } from "./presentation/controllers/media-upload.controller";
import { AuthProfileClient } from "./application/clients/auth-profile.client";
import { AvatarService } from "./application/services/avatar.service";
import { MediaAssetService } from "./application/services/media-asset.service";
import { MediaUploadService } from "./application/services/media-upload.service";

@Module({
  controllers: [MediaUploadController, MediaAssetController],
  providers: [
    MediaUploadService,
    MediaAssetService,
    AuthProfileClient,
    AvatarService,
  ],
  exports: [MediaUploadService, MediaAssetService, AvatarService],
})
export class MediaModule {}
