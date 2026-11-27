import { Body, Controller, Delete, Get, Header, Param, Post, Query, Req, Sse, type MessageEvent } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiHeader,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { PROTOCOL_HEADER } from '@fieldsync/sync-core';
import { accessibleSites } from './access';
import type { AuthedRequest } from './auth';
import { Db } from './db';
import { PullService } from './pull.service';
import { SUPPORTED_PROTOCOL } from './protocol.guard';
import { PushService } from './push.service';
import { SnapshotService } from './snapshot.service';
import { StreamService } from './stream.service';
import {
  clientIdOf,
  ClientParamsDto,
  ProblemDto,
  PullQueryDto,
  PullResponseDto,
  PushRequestDto,
  PushResponseDto,
  pushRequestOf,
  RetiredClientDto,
  SnapshotPageDto,
  SnapshotQueryDto,
} from './sync.dto';

@ApiTags('sync')
@ApiBearerAuth()
@ApiHeader({
  name: PROTOCOL_HEADER,
  required: true,
  description: `Version of the sync protocol the client speaks (this server: ${SUPPORTED_PROTOCOL.min} to ${SUPPORTED_PROTOCOL.max}).`,
})
@ApiBadRequestResponse({
  description:
    'A client without a supported protocol version (CLIENT_UPDATE_REQUIRED, details.min/max): update the app.',
  type: ProblemDto,
})
@ApiServiceUnavailableResponse({
  description: 'A client newer than the server (SERVER_UPDATE_REQUIRED, Retry-After): retry later.',
  type: ProblemDto,
})
@ApiUnauthorizedResponse({ description: 'Missing or unknown bearer token.', type: ProblemDto })
@ApiInternalServerErrorResponse({ description: 'An unexpected failure (code INTERNAL).', type: ProblemDto })
@Controller()
export class SyncController {
  constructor(
    private readonly db: Db,
    private readonly pushService: PushService,
    private readonly pullService: PullService,
    private readonly snapshotService: SnapshotService,
    private readonly streams: StreamService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'The authenticated user and the sites they can access' })
  @ApiOkResponse({ description: '`{ id, role, sites: [{ id, name }] }`, sites ordered by name.' })
  async me(@Req() req: AuthedRequest) {
    const siteIds = await accessibleSites(this.db, req.user);
    const { rows } = await this.db.query(`SELECT id, name FROM sites WHERE id = ANY($1) ORDER BY name`, [siteIds]);
    return { id: req.user.id, role: req.user.role, sites: rows };
  }

  @Post('sync/push')
  @ApiOperation({
    summary: 'Apply a batch of mutations from one client',
    description:
      'Mutations are applied in order, each in its own transaction, at most once however many copies arrive. ' +
      'A copy of a handled mutation gets the original result. A rejected mutation is final and does not stop the batch.',
  })
  @ApiCreatedResponse({ description: 'One result per mutation.', type: PushResponseDto })
  @ApiBadRequestResponse({ description: 'A malformed body (code BAD_REQUEST, errors per field).', type: ProblemDto })
  @ApiConflictResponse({
    description: 'A mutation id skips ahead of the last applied one (MUTATION_OUT_OF_ORDER, details.expected).',
    type: ProblemDto,
  })
  @ApiGoneResponse({
    description: 'The client id was retired (CLIENT_RETIRED, details.lastMutationId): continue under the new id.',
    type: ProblemDto,
  })
  @ApiPayloadTooLargeResponse({ description: 'The body exceeds JSON_BODY_LIMIT_BYTES.', type: ProblemDto })
  @ApiServiceUnavailableResponse({
    description: 'A transient database failure (TRANSIENT, Retry-After); the mutations before it were applied.',
    type: ProblemDto,
  })
  push(@Req() req: AuthedRequest, @Body() body: PushRequestDto) {
    return this.pushService.push(req.user, pushRequestOf(body));
  }

  @Delete('sync/clients/:clientId')
  @ApiOperation({
    summary: 'Retire a client id of the user',
    description:
      'After a 409 MUTATION_OUT_OF_ORDER the client continues under a new id. Once retired, an id applies no new ' +
      'mutation (410 CLIENT_RETIRED), so a late copy of an old request cannot apply what the client sends again ' +
      'under the new id; copies of handled mutations still get their results. Idempotent.',
  })
  @ApiOkResponse({ type: RetiredClientDto })
  @ApiNotFoundResponse({ description: 'The id belongs to another user.', type: ProblemDto })
  @ApiServiceUnavailableResponse({
    description: 'A transient database failure (TRANSIENT, Retry-After).',
    type: ProblemDto,
  })
  @Header('Cache-Control', 'no-store')
  retire(@Req() req: AuthedRequest, @Param() params: ClientParamsDto) {
    return this.pushService.retire(req.user, clientIdOf(params.clientId));
  }

  @Get('sync/pull')
  @ApiOperation({
    summary: 'Changes after a cursor, for the sites the user can access',
    description: 'One snapshot: the page, the cursor and lastMutationId are consistent with each other.',
  })
  @ApiOkResponse({ type: PullResponseDto })
  @ApiBadRequestResponse({ description: 'A cursor, limit or client id that is not valid.', type: ProblemDto })
  @ApiGoneResponse({
    description:
      'The cursor is below the floor of the change log (RESET_REQUIRED, details.floor): reload the state from GET /sync/snapshot.',
    type: ProblemDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'A transient database failure (TRANSIENT, Retry-After).',
    type: ProblemDto,
  })
  // Sync answers are the user's data and change with every write: never stored by a cache.
  @Header('Cache-Control', 'no-store')
  pull(@Req() req: AuthedRequest, @Query() query: PullQueryDto) {
    const clientId = query.clientId === undefined ? undefined : clientIdOf(query.clientId);
    return this.pullService.pull(req.user, query.cursor, query.limit, clientId);
  }

  @Get('sync/snapshot')
  @ApiOperation({
    summary: 'The live state of the sites the user can access, page by page',
    description:
      'For a client without state, or one answered RESET_REQUIRED. The first page fixes the watermark (the head of ' +
      'the change log); every next page passes it with the key of the previous page. After the last page the ' +
      'client pulls from the watermark and only then replaces its state.',
  })
  @ApiOkResponse({ type: SnapshotPageDto })
  @ApiBadRequestResponse({
    description: 'An incomplete or invalid page key, a limit out of range, or a watermark ahead of the log.',
    type: ProblemDto,
  })
  @ApiGoneResponse({
    description: 'The watermark fell below the floor of the change log (RESET_REQUIRED): start a new snapshot.',
    type: ProblemDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'A transient database failure (TRANSIENT, Retry-After).',
    type: ProblemDto,
  })
  @Header('Cache-Control', 'no-store')
  snapshot(@Req() req: AuthedRequest, @Query() query: SnapshotQueryDto) {
    const after =
      query.afterSite !== undefined && query.afterEntity !== undefined && query.afterId !== undefined
        ? { siteId: query.afterSite, entity: query.afterEntity, id: query.afterId }
        : undefined;
    return this.snapshotService.page(req.user, { watermark: query.watermark, after, limit: query.limit });
  }

  @Sse('sync/stream')
  @ApiOperation({
    summary: 'Server-sent events: a `poke` event whenever an accessible site changes',
    description:
      'The first event is `ready` with `{ heartbeatMs }`; then `poke` (merged within 250 ms) whenever a site of the ' +
      'user changes, and `heartbeat` every heartbeatMs. The client pulls after `ready` and after every poke, and ' +
      'reconnects when the stream stays silent for three heartbeat intervals.',
  })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({ description: 'An open event stream.' })
  // Synchronous on purpose: Nest 10 starts listening for the connection's close only once the handler
  // has returned the Observable, so a client that left while an async handler awaited would leave
  // its subscription behind. The sites are looked up inside the Observable instead.
  stream(@Req() req: AuthedRequest): Observable<MessageEvent> {
    return this.streams.events({
      sites: () => accessibleSites(this.db, req.user),
      backedUp: () => req.socket.writableNeedDrain,
      drop: () => req.socket.destroy(),
    });
  }
}
