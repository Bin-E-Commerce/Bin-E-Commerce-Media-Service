import { Module } from "@nestjs/common";
import { MediaUploadController } from "./controllers/media-upload.controller";
import { MediaUploadService } from "./services/media-upload.service";

@Module({
  controllers: [MediaUploadController],
  providers: [MediaUploadService],
  exports: [MediaUploadService],
})
export class MediaModule {}
