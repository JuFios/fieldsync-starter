import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from './public.decorator';
import { StreamService } from './stream.service';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly streams: StreamService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness of the server process' })
  @ApiOkResponse({ description: 'The process is running; `streams` is the number of open notification streams.' })
  check() {
    return { status: 'ok', streams: this.streams.count };
  }
}
