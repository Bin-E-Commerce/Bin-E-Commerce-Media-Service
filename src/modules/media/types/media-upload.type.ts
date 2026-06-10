import type {
  MEDIA_UPLOAD_MIME_TYPES,
  MEDIA_UPLOAD_PURPOSES,
} from "../constants/media-upload.constant";

export type MediaUploadPurpose = (typeof MEDIA_UPLOAD_PURPOSES)[number];

export type MediaUploadMimeType = (typeof MEDIA_UPLOAD_MIME_TYPES)[number];

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
