import { IsBase64, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

//  Payload noi bo nhan output da xu ly tu AI Worker, khong cho client public goi.
export class AiAssetUploadDto {
  //  Owner seller dung de tao prefix S3 va ngan upload cheo shop.
  @IsUUID()
  sellerOwnerId: string;

  //  Job ID dung cho audit va cleanup theo batch.
  @IsUUID()
  jobId: string;

  //  Noi dung anh da encode, gioi han de tranh body khong kiem soat.
  @IsBase64()
  @MinLength(16)
  @MaxLength(12_000_000)
  contentBase64: string;

  //  MIME da duoc provider xac nhan.
  @IsString()
  @MaxLength(80)
  contentType: string;

  //  Ten file chi de hien thi, service se sanitize truoc khi tao key.
  @IsString()
  @MaxLength(160)
  fileName: string;
}

