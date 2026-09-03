import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsUUID,
  ValidateNested,
} from "class-validator";
import { REVIEW_MEDIA_CLEANUP_PURPOSES } from "../../application/constants/media-upload.constant";
import type { ReviewMediaCleanupAsset } from "../../application/types/media-upload.type";

export class ReviewMediaCleanupAssetDto implements ReviewMediaCleanupAsset {
  @IsUUID("all")
  assetId: string;

  @IsIn(REVIEW_MEDIA_CLEANUP_PURPOSES)
  purpose: ReviewMediaCleanupAsset["purpose"];
}

export class CleanupReviewAssetsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReviewMediaCleanupAssetDto)
  assets: ReviewMediaCleanupAssetDto[];
}
