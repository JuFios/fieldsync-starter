import { Controller, Get } from '@nestjs/common';
import { Public } from './public.decorator';
import { StreamService } from './stream.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly streams: StreamService) {}

  @Get()
  check() {
    return { status: 'ok', streams: this.streams.count };
  }
}
