import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsUUID,
  ValidateNested,
} from "class-validator";
import { PRODUCT_MEDIA_CLEANUP_PURPOSES } from "../constants/media-upload.constant";
import type { ProductMediaCleanupPurpose } from "../types/media-upload.type";

export class ProductMediaCleanupAssetDto {
  // Asset import có thể dùng UUID v5, còn asset upload mới thường là UUID v4.
  @IsUUID("all")
  assetId: string;

  @IsIn(PRODUCT_MEDIA_CLEANUP_PURPOSES)
  purpose: ProductMediaCleanupPurpose;
}

export class CleanupProductAssetsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ProductMediaCleanupAssetDto)
  assets: ProductMediaCleanupAssetDto[];
}
