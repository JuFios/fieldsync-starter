import { BadRequestException, ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PullQueryDto, PushRequestDto } from '../src/sync.dto';

/** The pipe exactly as AppModule registers it. */
const pipe = new ValidationPipe({ whitelist: true, transform: true, stopAtFirstError: true });
const body: ArgumentMetadata = { type: 'body', metatype: PushRequestDto };
const query: ArgumentMetadata = { type: 'query', metatype: PullQueryDto };

describe('PullQueryDto', () => {
  it('defaults to the start of the log and a full page', async () => {
    expect(await pipe.transform({}, query)).toEqual(Object.assign(new PullQueryDto(), { cursor: 0, limit: 500 }));
  });

  it('converts decimal strings and keeps the client id', async () => {
    const clientId = randomUUID();
    const dto = (await pipe.transform({ cursor: '42', limit: '7', clientId }, query)) as PullQueryDto;
    expect({ cursor: dto.cursor, limit: dto.limit, clientId: dto.clientId }).toEqual({
      cursor: 42,
      limit: 7,
      clientId,
    });
  });

  it.each([
    [{ cursor: '1e3' }],
    [{ cursor: '' }],
    [{ cursor: ['1', '2'] }],
    [{ cursor: String(Number.MAX_SAFE_INTEGER + 1) }],
    [{ limit: '0' }],
    [{ limit: '501' }],
    [{ clientId: 'c1' }],
  ])('rejects %j', async (input) => {
    await expect(pipe.transform(input, query)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PushRequestDto', () => {
  const clientId = randomUUID();

  it('keeps the arguments exactly, keys class-transformer cannot copy included', async () => {
    const args = JSON.parse(
      '{"title":"T","constructor":{"prototype":{}},"__proto__":{"x":1},"deep":[{"constructor":"c"}]}',
    ) as Record<string, unknown>;
    const dto = (await pipe.transform(
      { clientId, mutations: [{ id: 1, name: 'ticket.create', args }] },
      body,
    )) as PushRequestDto;
    expect(dto.mutations[0].args).toBe(args);
  });

  it('strips properties the protocol does not define, outside the arguments', async () => {
    const dto = (await pipe.transform(
      { clientId, extra: 1, mutations: [{ id: 1, name: 'n', args: {}, extra: 2 }] },
      body,
    )) as PushRequestDto & { extra?: unknown };
    expect([dto.extra, (dto.mutations[0] as unknown as { extra?: unknown }).extra]).toEqual([undefined, undefined]);
  });

  it.each([
    [{ clientId: 'c', mutations: [] }],
    [{ clientId, mutations: {} }],
    [{ clientId, mutations: [null] }],
    [{ clientId, mutations: [{ id: 0, name: 'n', args: {} }] }],
    [{ clientId, mutations: [{ id: Number.MAX_SAFE_INTEGER + 1, name: 'n', args: {} }] }],
    [{ clientId, mutations: [{ id: '1', name: 'n', args: {} }] }],
    [{ clientId, mutations: [{ id: 1, name: 'n'.repeat(65), args: {} }] }],
    [{ clientId, mutations: [{ id: 1, name: 'n', args: [] }] }],
    [{ clientId, mutations: [{ id: 1, name: 'n', args: null }] }],
    [{ clientId, mutations: Array.from({ length: 101 }, (_, i) => ({ id: i + 1, name: 'n', args: {} })) }],
  ])('rejects %j', async (input) => {
    await expect(pipe.transform(input, body)).rejects.toBeInstanceOf(BadRequestException);
  });
});
