import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsInt, IsNotEmpty, IsString, Max, Min } from "class-validator";
import {
  MEDIA_UPLOAD_MIME_TYPES,
  MEDIA_UPLOAD_PURPOSES,
} from "../../application/constants/media-upload.constant";
import type {
  MediaUploadMimeType,
  MediaUploadPurpose,
} from "../../application/types/media-upload.type";

// Dto để tạo một presigned URL để upload file lên S3. Dto này sẽ được sử dụng trong controller để nhận dữ liệu từ client khi yêu cầu tạo presigned URL. Dto này bao gồm các trường sau:
// - fileName: tên của file sẽ được upload lên S3. Trường này là bắt buộc và phải là một chuỗi không rỗng.
// - contentType: loại MIME của file sẽ được upload lên S3. Trường này là bắt buộc và phải là một trong các giá trị được định nghĩa trong MEDIA_UPLOAD_MIME_TYPES.
// - fileSize: kích thước của file sẽ được upload lên S3, tính bằng byte. Trường này là bắt buộc và phải là một số nguyên dương, tối đa là 20MB.
// - purpose: mục đích của việc upload file lên S3. Trường này là bắt buộc và phải là một trong các giá trị được định nghĩa trong MEDIA_UPLOAD_PURPOSES.
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
  @Max(30 * 1024 * 1024)
  fileSize: number;

  @ApiProperty({ enum: MEDIA_UPLOAD_PURPOSES, example: "avatar" })
  @IsIn(MEDIA_UPLOAD_PURPOSES)
  purpose: MediaUploadPurpose;
}
