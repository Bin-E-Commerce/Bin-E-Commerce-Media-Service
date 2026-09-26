import { Module } from '@nestjs/common';
import { MediaAssetController } from '@/modules/media/presentation/controllers/media-asset.controller';
import { MediaUploadController } from '@/modules/media/presentation/controllers/media-upload.controller';
import { AuthProfileClient } from '@/modules/media/application/clients/auth-profile.client';
import { AvatarService } from '@/modules/media/application/services/avatar.service';
import { MediaAssetService } from '@/modules/media/application/services/media-asset.service';
import { MediaUploadService } from '@/modules/media/application/services/media-upload.service';

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
