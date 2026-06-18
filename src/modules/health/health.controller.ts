import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  HealthCheck,
  HealthCheckService,
  type HealthCheckResult,
} from "@nestjs/terminus";
import { MediaHealthIndicator } from "./indicators/media-health.indicator";

type ServiceHealthResult = HealthCheckResult & {
  service: "media-service";
  version: string;
  environment: string;
  timestamp: string;
  uptimeSeconds: number;
  memory: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
  };
};

@Controller("health")
export class HealthController {
  // Khởi tạo controller với dịch vụ tổng hợp health check và indicator riêng của media-service.
  constructor(
    private readonly configService: ConfigService,
    private readonly health: HealthCheckService,
    private readonly mediaHealth: MediaHealthIndicator,
  ) {}

  // Giữ endpoint health mặc định tương thích với hệ thống cũ và thực hiện đầy đủ kiểm tra readiness.
  @Get()
  @HealthCheck()
  check(): Promise<ServiceHealthResult> {
    return this.buildReadinessResult();
  }

  // Xác nhận tiến trình HTTP còn sống mà không phụ thuộc vào trạng thái tạm thời của AWS.
  @Get("live")
  liveness(): {
    status: "ok";
    service: "media-service";
    timestamp: string;
    uptimeSeconds: number;
  } {
    return {
      status: "ok",
      service: "media-service",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  // Kiểm tra service đã đủ cấu hình và có thể truy cập S3 trước khi nhận traffic upload.
  @Get("ready")
  @HealthCheck()
  readiness(): Promise<ServiceHealthResult> {
    return this.buildReadinessResult();
  }

  // Chạy các indicator độc lập rồi bổ sung metadata vận hành thống nhất với các service còn lại.
  private async buildReadinessResult(): Promise<ServiceHealthResult> {
    const result = await this.health.check([
      () => this.mediaHealth.checkConfiguration(),
      () => this.mediaHealth.checkS3(),
    ]);

    return {
      ...result,
      service: "media-service",
      version: this.configService.get<string>("APP_VERSION", "1.0.0"),
      environment: this.configService.get<string>(
        "NODE_ENV",
        "development",
      ),
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      memory: this.memoryUsage(),
    };
  }

  // Chuẩn hóa thông tin bộ nhớ về MB để dễ theo dõi giữa các môi trường triển khai.
  private memoryUsage(): {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
  } {
    const usage = process.memoryUsage();

    return {
      rssMb: Math.round(usage.rss / 1024 / 1024),
      heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(usage.heapTotal / 1024 / 1024),
    };
  }
}
