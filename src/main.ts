import { ValidationPipe, VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { AppModule } from "./app.module";

// Khởi động HTTP server cho media-service và gắn các middleware bảo mật/validation dùng chung.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn", "log"],
  });

  app.getHttpAdapter().getInstance().set("trust proxy", 1);

  const config = app.get(ConfigService);
  const isDev = config.get<string>("NODE_ENV") !== "production";
  const port = config.get<number>("PORT", 3010);

  app.use(helmet());
  app.setGlobalPrefix("api");
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.enableCors({ origin: false });

  if (isDev) {
    const documentConfig = new DocumentBuilder()
      .setTitle("Media Service")
      .setVersion("1.0")
      .addBearerAuth()
      .build();
    SwaggerModule.setup(
      "docs",
      app,
      SwaggerModule.createDocument(app, documentConfig),
    );
  }

  app.enableShutdownHooks();
  await app.listen(port);
  console.log(`[media-service] Running on port ${port}`);
}

void bootstrap();
