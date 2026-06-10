import { ApiProperty } from "@nestjs/swagger";
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
} from "class-validator";
import {
  MEDIA_UPLOAD_MIME_TYPES,
  MEDIA_UPLOAD_PURPOSES,
} from "../constants/media-upload.constant";
import type {
  MediaUploadMimeType,
  MediaUploadPurpose,
} from "../types/media-upload.type";

export class CreatePresignedUploadDto {
  @ApiProperty({ example: "avatar.jpg" })
  @IsString()
  @IsNotEmpty()
  fileName: string;

  @ApiProperty({ enum: MEDIA_UPLOAD_MIME_TYPES, example: "image/jpeg" })
  @IsIn(MEDIA_UPLOAD_MIME_TYPES)
  contentType: MediaUploadMimeType;

  @ApiProperty({ example: 1200000 })
  @IsInt()
  @Min(1)
  @Max(20 * 1024 * 1024)
  fileSize: number;

  @ApiProperty({ enum: MEDIA_UPLOAD_PURPOSES, example: "avatar" })
  @IsIn(MEDIA_UPLOAD_PURPOSES)
  purpose: MediaUploadPurpose;
}
