import { Module, type DynamicModule } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthGuard } from './auth';
import { Clock, SystemClock } from './clock';
import { configModule, type EnvOverride } from './config.module';
import { typeOrmOptions } from './database/typeorm';
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
  /**
   * The application module with its configuration and infrastructure modules. Resolves only after
   * the configuration has been validated (see {@link configModule}); `env` replaces the process
   * environment, for tests.
   */
  static async forRoot(env?: EnvOverride): Promise<DynamicModule> {
    return {
      module: AppModule,
      imports: [
        await configModule(env),
        TypeOrmModule.forRootAsync(typeOrmOptions('fieldsync-server')),
        ScheduleModule.forRoot(),
      ],
    };
  }
}
