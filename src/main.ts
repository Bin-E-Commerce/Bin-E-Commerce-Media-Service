// File này khởi động Media Service, cấu hình body parser, security boundary và telemetry.
// File không xử lý upload business rule; các module media/lambda sở hữu phần đó.

import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from '@/app.module';
import { setupHttpObservability } from '@common/observability/http-observability';

// Khởi động HTTP server cho media-service và gắn các middleware bảo mật/validation dùng chung.
// Khởi động media boundary sau khi cấu hình parser an toàn và middleware cross-cutting.
async function bootstrap(): Promise<void> {
    const app = await NestFactory.create(AppModule, {
        logger: ['error', 'warn', 'log'],
        bodyParser: false,
    });

    app.getHttpAdapter().getInstance().set('trust proxy', 1);

    const config = app.get(ConfigService);
    const isDev = config.get<string>('NODE_ENV') !== 'production';
    const port = config.get<number>('PORT', 3004);
    const requestBodyLimit = config.get<string>(
        'MEDIA_REQUEST_BODY_LIMIT',
        '12mb',
    );

    // Tắt parser mặc định để payload base64 của AI không bị Express chặn ở giới hạn 100 KB trước khi vào controller.
    app.use(json({ limit: requestBodyLimit }));
    app.use(urlencoded({ extended: true, limit: requestBodyLimit }));

    app.use(helmet());
    app.setGlobalPrefix('api');
    // Đăng ký metrics RED và request ID trước khi service bắt đầu nhận traffic.
    setupHttpObservability(app, 'media-service');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
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
            .setTitle('Media Service')
            .setVersion('1.0')
            .addBearerAuth()
            .build();
        SwaggerModule.setup(
            'docs',
            app,
            SwaggerModule.createDocument(app, documentConfig),
        );
    }

    app.enableShutdownHooks();
    await app.listen(port);
    console.log(`[media-service] Running on port ${port}`);
}

void bootstrap();
