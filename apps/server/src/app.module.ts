import { Module, ValidationPipe, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
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
    { provide: Clock, useClass: SystemClock },
    PushService,
    PullService,
    StreamService,
    GcService,
    // Every route requires a token unless it is marked @Public() (NestJS authentication docs).
    { provide: APP_GUARD, useClass: AuthGuard },
    // Global validation, registered in the module so in-process test applications get it too. It
    // checks DTO-typed parameters; `whitelist` strips properties a DTO does not declare.
    { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, transform: true }) },
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
