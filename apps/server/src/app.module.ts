import { Module, ValidationPipe, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthGuard } from './auth';
import { Clock, SystemClock } from './clock';
import { configModule, type EnvOverride } from './config.module';
import { typeOrmOptions } from './database/typeorm';
import { Db } from './db';
import { GcService } from './gc.service';
import { HealthController } from './health.controller';
import { ProblemFilter } from './problem';
import { ProtocolGuard } from './protocol.guard';
import { PullService } from './pull.service';
import { PushService } from './push.service';
import { SnapshotService } from './snapshot.service';
import { StreamService } from './stream.service';
import { SyncController } from './sync.controller';

@Module({
  controllers: [SyncController, HealthController],
  providers: [
    Db,
    { provide: Clock, useClass: SystemClock },
    PushService,
    PullService,
    SnapshotService,
    StreamService,
    GcService,
    // Global guards run in this order: the protocol version first, so an outdated client is told to
    // update whatever else is wrong; then the token, required unless a route is @Public() (NestJS
    // authentication docs).
    { provide: APP_GUARD, useClass: ProtocolGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    // Global validation, registered in the module so in-process test applications get it too. It
    // checks DTO-typed parameters; `whitelist` strips properties a DTO does not declare.
    // `stopAtFirstError`: one message per invalid property.
    { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, transform: true, stopAtFirstError: true }) },
    // Every error is answered as a problem (RFC 9457), see ProblemFilter.
    { provide: APP_FILTER, useClass: ProblemFilter },
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
