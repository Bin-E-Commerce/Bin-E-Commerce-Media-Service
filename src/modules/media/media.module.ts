import { Module } from "@nestjs/common";
import { MediaAssetController } from "./controllers/media-asset.controller";
import { MediaUploadController } from "./controllers/media-upload.controller";
import { AuthProfileClient } from "./services/auth-profile.client";
import { AvatarService } from "./services/avatar.service";
import { MediaAssetService } from "./services/media-asset.service";
import { MediaUploadService } from "./services/media-upload.service";

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
