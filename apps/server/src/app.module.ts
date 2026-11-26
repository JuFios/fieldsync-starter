import { DynamicModule, Module } from '@nestjs/common';
import { AuthGuard } from './auth';
import { Clock, SystemClock } from './clock';
import { AppConfig } from './config';
import { Db } from './db';
import { GcService } from './gc.service';
import { HealthController } from './health.controller';
import { PullService } from './pull.service';
import { PushService } from './push.service';
import { StreamService } from './stream.service';
import { SyncController } from './sync.controller';

@Module({
  controllers: [SyncController, HealthController],
  providers: [
    Db,
    AuthGuard,
    { provide: Clock, useClass: SystemClock },
    PushService,
    PullService,
    StreamService,
    GcService,
  ],
})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return { module: AppModule, providers: [{ provide: AppConfig, useValue: config }] };
  }
}
