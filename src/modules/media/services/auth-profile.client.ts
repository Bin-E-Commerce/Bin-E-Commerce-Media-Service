import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  AuthAvatarUpdateResult,
  AuthUserProfile,
} from "../types/media-upload.type";

interface AuthAvatarUpdateResponse {
  data: {
    user: AuthUserProfile;
    oldAvatarUrl: string | null;
  };
}

@Injectable()
export class AuthProfileClient {
  private readonly authServiceUrl: string;
  private readonly internalServiceToken: string;

  // Đọc địa chỉ Auth Service và shared token một lần để mọi request nội bộ dùng cùng cấu hình.
  constructor(private readonly configService: ConfigService) {
    this.authServiceUrl = this.configService
      .get<string>("AUTH_SERVICE_URL", "http://localhost:3001")
      .replace(/\/$/, "");
    this.internalServiceToken = this.configService.get<string>(
      "INTERNAL_SERVICE_TOKEN",
      "",
    );
  }

  // Gọi Auth Service cập nhật avatar và nhận URL cũ để Media Service tiếp tục cleanup S3.
  async updateAvatar(
    userId: string,
    avatarUrl: string,
  ): Promise<AuthAvatarUpdateResult> {
    if (!this.internalServiceToken) {
      throw new ServiceUnavailableException(
        "INTERNAL_SERVICE_TOKEN is not configured",
      );
    }

    let response: Response;

    try {
      response = await fetch(
        `${this.authServiceUrl}/api/v1/internal/users/avatar`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-internal-service-token": this.internalServiceToken,
            "x-user-id": userId,
          },
          body: JSON.stringify({ avatarUrl }),
          signal: AbortSignal.timeout(5_000),
        },
      );
    } catch (error) {
      throw new ServiceUnavailableException(
        error instanceof Error
          ? `Auth Service unavailable: ${error.message}`
          : "Auth Service unavailable",
      );
    }

    if (!response.ok) {
      throw new BadGatewayException(
        `Auth Service rejected avatar update with status ${response.status}`,
      );
    }

    const payload = (await response.json()) as AuthAvatarUpdateResponse;

    return {
      user: payload.data.user,
      oldAvatarUrl: payload.data.oldAvatarUrl,
    };
  }
}
