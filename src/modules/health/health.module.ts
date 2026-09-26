import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from '@/modules/health/health.controller';
import { MediaHealthIndicator } from '@/modules/health/indicators/media-health.indicator';

@Module({
    imports: [TerminusModule],
    controllers: [HealthController],
    providers: [MediaHealthIndicator],
})
export class HealthModule {}
