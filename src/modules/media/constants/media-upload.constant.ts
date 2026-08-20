export const MEDIA_IMAGE_UPLOAD_PURPOSES = [
  "avatar",
  "product_image",
  "shop_avatar",
  "shop_cover",
  "seller_document",
  "review_image",
  "chat_image",
] as const;

export const MEDIA_VIDEO_UPLOAD_PURPOSES = ["product_video"] as const;

export const MEDIA_UPLOAD_PURPOSES = [
  ...MEDIA_IMAGE_UPLOAD_PURPOSES,
  ...MEDIA_VIDEO_UPLOAD_PURPOSES,
] as const;

export const MEDIA_IMAGE_UPLOAD_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/jpg",
  "image/webp",
] as const;

export const MEDIA_VIDEO_UPLOAD_MIME_TYPES = ["video/mp4", "video/webm"] as const;

export const MEDIA_UPLOAD_MIME_TYPES = [
  ...MEDIA_IMAGE_UPLOAD_MIME_TYPES,
  ...MEDIA_VIDEO_UPLOAD_MIME_TYPES,
] as const;

export const MEDIA_MAX_IMAGE_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024;
export const MEDIA_MAX_VIDEO_UPLOAD_SIZE_BYTES = 30 * 1024 * 1024;

// Giữ alias cũ để cấu hình triển khai hiện tại vẫn tương thích; ảnh là loại tệp mặc định của media-service.
export const MEDIA_MAX_UPLOAD_SIZE_BYTES = MEDIA_MAX_IMAGE_UPLOAD_SIZE_BYTES;

export const MEDIA_UPLOAD_EXTENSION_BY_MIME_TYPE = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
} as const;
