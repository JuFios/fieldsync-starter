import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { accessibleSites } from './access';
import type { AuthedRequest } from './auth';
import { Db } from './db';
import { PullService } from './pull.service';
import { PushService } from './push.service';
import { StreamService } from './stream.service';
import { ProblemDto, PullQueryDto, PullResponseDto, PushRequestDto, PushResponseDto } from './sync.dto';

@ApiTags('sync')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or unknown bearer token.', type: ProblemDto })
@ApiInternalServerErrorResponse({ description: 'An unexpected failure (code INTERNAL).', type: ProblemDto })
@Controller()
export class SyncController {
  constructor(
    private readonly db: Db,
    private readonly pushService: PushService,
    private readonly pullService: PullService,
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
  @ApiPayloadTooLargeResponse({ description: 'The body exceeds JSON_BODY_LIMIT_BYTES.', type: ProblemDto })
  @ApiServiceUnavailableResponse({
    description: 'A transient database failure (TRANSIENT, Retry-After); the mutations before it were applied.',
    type: ProblemDto,
  })
  push(@Req() req: AuthedRequest, @Body() body: PushRequestDto) {
    return this.pushService.push(req.user, body);
  }

  @Get('sync/pull')
  @ApiOperation({
    summary: 'Changes after a cursor, for the sites the user can access',
    description: 'One snapshot: the page, the cursor and lastMutationId are consistent with each other.',
  })
  @ApiOkResponse({ type: PullResponseDto })
  @ApiBadRequestResponse({ description: 'A cursor, limit or client id that is not valid.', type: ProblemDto })
  @ApiServiceUnavailableResponse({
    description: 'A transient database failure (TRANSIENT, Retry-After).',
    type: ProblemDto,
  })
  pull(@Req() req: AuthedRequest, @Query() query: PullQueryDto) {
    return this.pullService.pull(req.user, query.cursor, query.limit, query.clientId);
  }

  @Get('sync/stream')
  @ApiOperation({
    summary: 'Server-sent events: a `poke` event whenever an accessible site changes',
    description: 'The client pulls after a poke.',
  })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({ description: 'An open event stream.' })
  async stream(@Req() req: AuthedRequest, @Res() res: Response) {
    const sites = await accessibleSites(this.db, req.user);
    this.streams.add(sites, res);
  }
}
