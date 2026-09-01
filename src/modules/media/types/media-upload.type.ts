import type {
  MEDIA_UPLOAD_MIME_TYPES,
  MEDIA_UPLOAD_PURPOSES,
  PRODUCT_MEDIA_CLEANUP_PURPOSES,
  REVIEW_MEDIA_CLEANUP_PURPOSES,
} from "../constants/media-upload.constant";

export type MediaUploadPurpose = (typeof MEDIA_UPLOAD_PURPOSES)[number];

export type MediaUploadMimeType = (typeof MEDIA_UPLOAD_MIME_TYPES)[number];

export type ProductMediaCleanupPurpose =
  (typeof PRODUCT_MEDIA_CLEANUP_PURPOSES)[number];

export type ReviewMediaCleanupPurpose =
  (typeof REVIEW_MEDIA_CLEANUP_PURPOSES)[number];

export type MediaCleanupPurpose =
  | ProductMediaCleanupPurpose
  | ReviewMediaCleanupPurpose;

export interface MediaCleanupAsset {
  assetId: string;
  purpose: MediaCleanupPurpose;
}

export interface ProductMediaCleanupAsset {
  assetId: string;
  purpose: ProductMediaCleanupPurpose;
}

export interface ReviewMediaCleanupAsset {
  assetId: string;
  purpose: ReviewMediaCleanupPurpose;
}

export interface CleanupProductAssetsResponse {
  requestedAssetCount: number;
  deletedCount: number;
}

// Interface định nghĩa cấu trúc của response khi tạo presigned URL để upload file lên S3. Interface này bao gồm các trường sau:
export interface PresignedUploadResponse {
  assetId: string;
  objectKey: string;
  expiresIn: number;
  status: "uploading";
  upload: {
    url: string;
    fields: Record<string, string>;
  };
  publicBaseUrl: string | null;
}

// Interface định nghĩa cấu trúc của response khi xóa một media asset. Interface này bao gồm các trường sau:
export interface DeleteMediaAssetResponse {
  assetId: string;
  deletedCount: number;
}

export interface AuthUserProfile {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: string;
  status: string;
  avatarUrl: string | null;
  createdAt: string;
}

export interface AuthAvatarUpdateResult {
  user: AuthUserProfile;
  oldAvatarUrl: string | null;
}

export interface ConfirmAvatarResponse {
  assetId: string;
  avatarUrl: string;
  user: AuthUserProfile;
  cleanup: {
    status: "deleted" | "deferred" | "skipped";
    oldAssetId: string | null;
    deletedCount: number;
  };
}
