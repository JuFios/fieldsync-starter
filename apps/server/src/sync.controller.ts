import { BadRequestException, Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { PushRequest } from '@fieldsync/sync-core';
import type { Response } from 'express';
import { accessibleSites } from './access';
import type { AuthedRequest } from './auth';
import { Db } from './db';
import { PullService } from './pull.service';
import { PushService } from './push.service';
import { StreamService } from './stream.service';

function assertPushRequest(body: unknown): asserts body is PushRequest {
  const b = body as Partial<PushRequest> | null;
  const valid =
    b !== null &&
    typeof b === 'object' &&
    typeof b.clientId === 'string' &&
    b.clientId.length > 0 &&
    b.clientId.length <= 64 &&
    Array.isArray(b.mutations) &&
    b.mutations.length <= 100 &&
    b.mutations.every(
      (m) =>
        m !== null &&
        typeof m === 'object' &&
        Number.isInteger(m.id) &&
        m.id > 0 &&
        typeof m.name === 'string' &&
        m.args !== null &&
        typeof m.args === 'object',
    );
  if (!valid) throw new BadRequestException('Malformed push request');
}

@ApiTags('sync')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or unknown bearer token.' })
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
    description: 'Mutations are applied in order; ids already applied for the client are skipped.',
  })
  @ApiBody({ description: '`{ clientId, mutations: [{ id, name, args }] }`, at most 100 mutations.' })
  @ApiOkResponse({ description: '`{ results: [{ id, status, code?, message? }] }`, one result per mutation.' })
  @ApiBadRequestResponse({ description: 'Malformed request, or a mutation id out of order.' })
  @ApiInternalServerErrorResponse({ description: 'The batch failed while a mutation was applied.' })
  push(@Req() req: AuthedRequest, @Body() body: unknown) {
    assertPushRequest(body);
    return this.pushService.push(req.user, body);
  }

  @Get('sync/pull')
  @ApiOperation({ summary: 'Changes after a cursor, for the sites the user can access' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Version of the last change received; 0 to start.' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of changes (default 500).' })
  @ApiQuery({ name: 'clientId', required: false, description: 'Client whose last applied mutation id to return.' })
  @ApiOkResponse({ description: '`{ changes, nextCursor, hasMore, lastMutationId }`.' })
  pull(
    @Req() req: AuthedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('clientId') clientId?: string,
  ) {
    return this.pullService.pull(req.user, Number(cursor ?? 0) || 0, Number(limit ?? 500) || 500, clientId);
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
