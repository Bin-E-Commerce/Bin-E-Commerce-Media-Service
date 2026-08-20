# Video Processing Pipeline

Media Service xử lý video theo mô hình upload trực tiếp lên S3 và xử lý bất đồng bộ trên AWS Lambda. Backend không nhận và giữ toàn bộ file video trong RAM, nên phù hợp hơn với các file lớn và lưu lượng upload đồng thời.

## Luồng hoạt động

```text
Frontend
  -> Media Service: xin presigned POST
  -> S3: upload video gốc trực tiếp
  -> S3 ObjectCreated
  -> SQS: bin-ecommerce-media-video-resize
  -> Lambda: bin-ecommerce-media-video-processor
  -> S3: lưu các profile video và poster
  -> CloudFront: phân phối nội dung đã xử lý
```

Media Service vẫn chịu trách nhiệm xác thực người dùng, kiểm tra purpose, MIME type, dung lượng và tự tạo S3 key. Frontend chỉ nhận policy upload, không được tự chọn đường dẫn S3.

## Đầu vào và đầu ra

Video gốc được lưu theo prefix:

```text
uploads/original/product_video/{ownerId}/{assetId}/{safeFileName}.mp4
```

Lambda tạo các profile H.264/AAC phổ biến cho trình duyệt:

| Profile | Kích thước tối đa | Video bitrate | Mục đích |
| --- | ---: | ---: | --- |
| `360p.mp4` | 640x360 | 900 Kbps | Mạng chậm, preview |
| `720p.mp4` | 1280x720 | 2500 Kbps | Mặc định cho phần lớn thiết bị |
| `1080p.mp4` | 1920x1080 | 5000 Kbps | Màn hình lớn |
| `poster.webp` | 640x360 | N/A | Ảnh đại diện trong danh sách sản phẩm |
| `manifest.json` | N/A | N/A | Metadata và danh sách variant |

Đầu ra có dạng:

```text
media/processed/product_video/{purpose}/{ownerId}/{assetId}/360p.mp4
media/processed/product_video/{purpose}/{ownerId}/{assetId}/720p.mp4
media/processed/product_video/{purpose}/{ownerId}/{assetId}/1080p.mp4
media/processed/product_video/{purpose}/{ownerId}/{assetId}/poster.webp
media/processed/product_video/{purpose}/{ownerId}/{assetId}/manifest.json
```

`manifest.json` giúp frontend chọn profile phù hợp mà không phải hard-code danh sách file. Các file đã xử lý được upload với `Cache-Control: public, max-age=31536000, immutable` để tận dụng CloudFront cache.

## AWS resources hiện tại

| Resource | Tên |
| --- | --- |
| Lambda | `bin-ecommerce-media-video-processor` |
| ECR repository | `bin-ecommerce-media-video-processor` |
| SQS chính | `bin-ecommerce-media-video-resize` |
| SQS DLQ | `bin-ecommerce-media-video-resize-dlq` |
| S3 bucket | `bin-ecommerce` |
| Region | `ap-southeast-1` |
| Event source concurrency | `2` |
| SQS batch size | `1` |

SQS retry tối đa 3 lần. Message xử lý lỗi được chuyển vào DLQ để kiểm tra riêng, tránh làm nghẽn các video hợp lệ khác.

## Cấu trúc code

```text
lambda/video-processor/index.ts                 # Lambda handler và FFmpeg pipeline
lambda/video-processor/package.json             # Runtime dependency của Lambda
lambda/video-processor/Dockerfile               # Image Lambda có FFmpeg Linux
scripts/lambda/build-video-processor.ps1        # Build image linux/amd64
scripts/lambda/deploy-video-processor.ps1       # Push ECR và create/update Lambda
scripts/lambda/configure-video-pipeline.ps1     # Queue, DLQ, S3 event, IAM, mapping
```

Lambda xử lý tuần tự từng SQS record và từng profile video. Cách này ưu tiên giới hạn CPU/RAM của Lambda, tránh nhiều tiến trình FFmpeg chạy đồng thời trên cùng một invocation.

## Build và deploy

Chạy từ thư mục `services/media-service`:

```powershell
npm run type-check
npm run lambda:video:build
npm run lambda:video:deploy
```

Nếu image đã build và chỉ muốn cập nhật Lambda:

```powershell
npm run lambda:video:deploy -- -SkipBuild
```

Sau khi Lambda tồn tại, cấu hình event pipeline:

```powershell
npm run lambda:video:configure
```

Hoặc truyền rõ thông tin khi đổi account/region:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/lambda/configure-video-pipeline.ps1 `
  -FunctionName "bin-ecommerce-media-video-processor" `
  -BucketName "bin-ecommerce" `
  -Region "ap-southeast-1" `
  -RoleName "bin-ecommerce-media-image-processor-role"
```

## Kiểm tra sau deploy

1. Kiểm tra Lambda có `State=Active` và `LastUpdateStatus=Successful`.
2. Kiểm tra event source mapping ở Lambda có `State=Enabled`.
3. Kiểm tra S3 notification có prefix `uploads/original/product_video/`.
4. Upload một file MP4 nhỏ qua presigned POST.
5. Kiểm tra SQS chính giảm message và CloudWatch Logs có đủ ba profile.
6. Kiểm tra S3 có `360p.mp4`, `720p.mp4`, `1080p.mp4`, `poster.webp`, `manifest.json`.
7. Nếu xử lý thất bại, kiểm tra DLQ và log stream của Lambda.

## Giới hạn hiện tại và hướng mở rộng

Phiên bản hiện tại tạo nhiều profile MP4 để ưu tiên triển khai nhanh và tương thích trình duyệt. Chưa tạo HLS/DASH playlist. Khi cần adaptive streaming thực sự, có thể bổ sung `master.m3u8` và các segment HLS, hoặc chuyển workload nặng sang AWS MediaConvert; Lambda hiện tại vẫn phù hợp cho video ngắn và số lượng vừa phải.

Media asset database chưa tự nhận trạng thái `READY` từ completion event trong phiên bản này. Bước tiếp theo nên thêm worker cập nhật `media_asset`, lưu manifest URL và publish event cho product-service để frontend đọc trạng thái xử lý thay vì tự đoán qua thời gian chờ.
