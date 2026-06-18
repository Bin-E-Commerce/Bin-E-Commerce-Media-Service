import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from "@nestjs/terminus";

const S3_HEALTH_TIMEOUT_MS = 2_000;

@Injectable()
export class MediaHealthIndicator {
  private readonly bucket: string;
  private readonly cdnUrl: string;
  private readonly region: string;
  private readonly s3: S3Client;

  // Khởi tạo một S3 client dùng lại cho mọi lần kiểm tra để tránh tạo connection pool theo từng request.
  constructor(
    private readonly configService: ConfigService,
    private readonly indicator: HealthIndicatorService,
  ) {
    this.region = this.configService.get<string>(
      "AWS_REGION",
      "ap-southeast-1",
    );
    this.bucket = this.configService.get<string>("AWS_S3_BUCKET", "");
    this.cdnUrl = this.configService.get<string>("MEDIA_PUBLIC_CDN_URL", "");
    this.s3 = new S3Client({ region: this.region });
  }

  // Xác minh các biến bắt buộc và URL CloudFront hợp lệ trước khi service nhận request upload.
  checkConfiguration(): HealthIndicatorResult {
    const missingVariables = [
      ["AWS_S3_BUCKET", this.bucket],
      ["MEDIA_PUBLIC_CDN_URL", this.cdnUrl],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    const cdnUrlValid = this.isValidHttpsUrl(this.cdnUrl);
    const check = this.indicator.check("configuration");

    if (missingVariables.length > 0 || !cdnUrlValid) {
      return check.down({
        missingVariables,
        cdnUrlValid,
        region: this.region,
      });
    }

    return check.up({
      cdnUrlValid: true,
      region: this.region,
    });
  }

  // Gọi HeadBucket với timeout ngắn để xác nhận bucket tồn tại và runtime có quyền truy cập.
  async checkS3(): Promise<HealthIndicatorResult> {
    const check = this.indicator.check("s3");

    if (!this.bucket) {
      return check.down({ message: "AWS_S3_BUCKET is not configured" });
    }

    const startedAt = Date.now();
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      S3_HEALTH_TIMEOUT_MS,
    );

    try {
      await this.s3.send(
        new HeadBucketCommand({ Bucket: this.bucket }),
        { abortSignal: abortController.signal },
      );

      return check.up({
        bucket: this.bucket,
        latencyMs: Date.now() - startedAt,
        region: this.region,
      });
    } catch (error) {
      return check.down({
        bucket: this.bucket,
        latencyMs: Date.now() - startedAt,
        message: this.errorMessage(error),
        region: this.region,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  // Chỉ chấp nhận HTTPS để đường dẫn ảnh public không tạo mixed content trên frontend.
  private isValidHttpsUrl(value: string): boolean {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }

  // Chuyển lỗi SDK hoặc lỗi timeout thành thông điệp ngắn, không làm lộ stack trace qua health endpoint.
  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        return `S3 health check timed out after ${S3_HEALTH_TIMEOUT_MS} ms`;
      }

      const httpStatusCode = this.awsHttpStatusCode(error);

      return httpStatusCode
        ? `S3 request failed with HTTP ${httpStatusCode}`
        : error.message;
    }

    return "Unable to access the configured S3 bucket";
  }

  // Đọc mã HTTP từ metadata chuẩn của AWS SDK để phân biệt lỗi quyền 403 và bucket không tồn tại 404.
  private awsHttpStatusCode(error: unknown): number | undefined {
    if (!error || typeof error !== "object" || !("$metadata" in error)) {
      return undefined;
    }

    const metadata = error.$metadata;

    if (!metadata || typeof metadata !== "object") {
      return undefined;
    }

    const statusCode = Reflect.get(metadata, "httpStatusCode");

    return typeof statusCode === "number" ? statusCode : undefined;
  }
}
