import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  // Trả về trạng thái sống tối thiểu để Docker/API Gateway kiểm tra service còn chạy.
  @Get()
  check(): { status: "ok"; service: "media-service" } {
    return { status: "ok", service: "media-service" };
  }
}
