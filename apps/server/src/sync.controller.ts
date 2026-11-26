import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
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
import { PullQueryDto, PushRequestDto } from './sync.dto';

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
  @ApiOkResponse({ description: '`{ results: [{ id, status, code?, message? }] }`, one result per mutation.' })
  @ApiBadRequestResponse({ description: 'Malformed request, or a mutation id out of order.' })
  @ApiInternalServerErrorResponse({ description: 'The batch failed while a mutation was applied.' })
  push(@Req() req: AuthedRequest, @Body() body: PushRequestDto) {
    return this.pushService.push(req.user, body);
  }

  @Get('sync/pull')
  @ApiOperation({ summary: 'Changes after a cursor, for the sites the user can access' })
  @ApiOkResponse({ description: '`{ changes, nextCursor, hasMore, lastMutationId }`.' })
  @ApiBadRequestResponse({ description: 'A cursor, limit or client id that is not valid.' })
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
