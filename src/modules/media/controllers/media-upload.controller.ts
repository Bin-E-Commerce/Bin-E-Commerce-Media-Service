import {
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CreatePresignedUploadDto } from "../dto/create-presigned-upload.dto";
import { MediaUploadService } from "../services/media-upload.service";
import type { PresignedUploadResponse } from "../types/media-upload.type";

@ApiTags("media uploads")
@Controller("media/uploads")
export class MediaUploadController {
  constructor(private readonly mediaUploadService: MediaUploadService) {}
  // Cấp presigned POST để frontend upload trực tiếp lên S3, không đẩy file qua backend.
  @Post("presign")
  @ApiOperation({ summary: "Create a presigned S3 upload form" })
  createPresignedUpload(
    @Headers("x-user-id") userId: string | undefined,
    @Body() dto: CreatePresignedUploadDto,
  ): Promise<PresignedUploadResponse> {
    if (!userId) {
      throw new UnauthorizedException("Missing authenticated user context");
    }

    return this.mediaUploadService.createPresignedUpload(userId, dto);
  }
}
