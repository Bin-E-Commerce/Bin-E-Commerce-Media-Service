export const MEDIA_UPLOAD_PURPOSES = [
  "avatar",
  "product_image",
  "shop_avatar",
  "shop_cover",
  "seller_document",
  "review_image",
  "chat_image",
] as const;

export const MEDIA_UPLOAD_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/jpg",
  "image/webp",
] as const;

export const MEDIA_UPLOAD_EXTENSION_BY_MIME_TYPE = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
