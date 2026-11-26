import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IntegerIn } from './validation';

/** Most mutations in one push; the client sends larger queues in several batches. */
export const MAX_PUSH_MUTATIONS = 100;

/** Most changes one pull returns. */
export const MAX_PULL_LIMIT = 500;

/**
 * Largest mutation id and cursor: ids and versions travel as JSON numbers, which carry integers
 * exactly only up to 2^53 - 1.
 */
export const MAX_WIRE_INTEGER = Number.MAX_SAFE_INTEGER;

/** Longest mutator name accepted; the real names are much shorter, unknown ones are rejected per mutation. */
const MAX_MUTATOR_NAME = 64;

/**
 * The mutator's arguments exactly as the client sent them. class-transformer must not walk this
 * free-form object: version 0.5.1 throws a TypeError (a 500) on an object with an own `constructor`
 * key and silently drops `constructor` and `__proto__` keys. `@Type(() => String)` stops it at this
 * property and `@Transform` puts the untouched value back. The arguments are checked by the
 * mutator's own validator, shared with the client, so one bad argument rejects that mutation only.
 */
function UntouchedArguments(): PropertyDecorator {
  return applyDecorators(
    Type(() => String),
    Transform(({ obj }: TransformFnParams) => (obj as { args?: unknown }).args, { toClassOnly: true }),
  );
}

export class MutationDto {
  @ApiProperty({ description: 'Per-client mutation id: 1, 2, 3, … without gaps.', minimum: 1, example: 1 })
  @IsInt()
  @Min(1)
  @Max(MAX_WIRE_INTEGER)
  id!: number;

  @ApiProperty({ description: 'Mutator name.', example: 'ticket.create', maxLength: MAX_MUTATOR_NAME })
  @IsString()
  @MaxLength(MAX_MUTATOR_NAME)
  name!: string;

  @ApiProperty({
    description: 'Mutator arguments; checked by the mutator, see the rejection codes.',
    type: 'object',
    additionalProperties: true,
    example: { id: '5f0c3c0e-1d8e-4a8e-9c6b-2f3b7c1d9e10', siteId: '…', title: 'Pump leaks', description: '' },
  })
  @UntouchedArguments()
  @IsObject()
  args!: Record<string, unknown>;
}

export class PushRequestDto {
  @ApiProperty({ description: 'Id of the client installation (a UUID it generates once).', format: 'uuid' })
  @IsUUID()
  clientId!: string;

  @ApiProperty({ type: [MutationDto], maxItems: MAX_PUSH_MUTATIONS })
  @IsArray()
  @ArrayMaxSize(MAX_PUSH_MUTATIONS)
  @ValidateNested({ each: true })
  @Type(() => MutationDto)
  mutations!: MutationDto[];
}

export class PullQueryDto {
  @ApiPropertyOptional({
    description: 'Cursor returned by the previous pull; 0 to start.',
    minimum: 0,
    maximum: MAX_WIRE_INTEGER,
    default: 0,
  })
  @IntegerIn(0, MAX_WIRE_INTEGER)
  cursor: number = 0;

  @ApiPropertyOptional({ description: 'Most changes to return.', minimum: 1, maximum: MAX_PULL_LIMIT, default: 500 })
  @IntegerIn(1, MAX_PULL_LIMIT)
  limit: number = MAX_PULL_LIMIT;

  @ApiPropertyOptional({ description: 'Client whose last applied mutation id to return.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  clientId?: string;
}
