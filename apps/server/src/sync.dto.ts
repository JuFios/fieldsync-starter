import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { MAX_PUSH_MUTATIONS, REJECTION_CODES } from '@fieldsync/sync-core';
import { PROBLEM_CODES } from './problem';
import { IntegerIn } from './validation';

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

/** Most rows one snapshot page returns. */
export const MAX_SNAPSHOT_LIMIT = 500;

/** A page key is either complete (all three parts) or absent; a key needs its snapshot's watermark. */
const hasKey = (o: SnapshotQueryDto): boolean =>
  o.afterSite !== undefined || o.afterEntity !== undefined || o.afterId !== undefined;

export class SnapshotQueryDto {
  @ApiPropertyOptional({
    description:
      'The watermark of the first page of this snapshot; omit it for the first page. Required with a page key.',
    minimum: 0,
    maximum: MAX_WIRE_INTEGER,
  })
  @ValidateIf((o: SnapshotQueryDto) => hasKey(o) || o.watermark !== undefined)
  @IsDefined({ message: '$property is required with a page key' })
  @IntegerIn(0, MAX_WIRE_INTEGER)
  watermark?: number;

  @ApiPropertyOptional({ description: 'Site of the last row of the previous page (`next.siteId`).', format: 'uuid' })
  @ValidateIf(hasKey)
  @IsUUID()
  afterSite?: string;

  @ApiPropertyOptional({ description: 'Entity of the last row of the previous page.', enum: ['part', 'ticket'] })
  @ValidateIf(hasKey)
  @IsIn(['part', 'ticket'])
  afterEntity?: 'part' | 'ticket';

  @ApiPropertyOptional({ description: 'Id of the last row of the previous page.', format: 'uuid' })
  @ValidateIf(hasKey)
  @IsUUID()
  afterId?: string;

  @ApiPropertyOptional({ description: 'Most rows to return.', minimum: 1, maximum: MAX_SNAPSHOT_LIMIT, default: 500 })
  @IntegerIn(1, MAX_SNAPSHOT_LIMIT)
  limit: number = MAX_SNAPSHOT_LIMIT;
}

// Answers, for the OpenAPI description (the services return the sync-core types they mirror).

export class MutationResultDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ enum: ['applied', 'duplicate', 'rejected'] })
  status!: 'applied' | 'duplicate' | 'rejected';

  @ApiPropertyOptional({
    description: 'Applied and duplicate: change-log version of the last change; absent when nothing changed.',
  })
  version?: number;

  @ApiPropertyOptional({ enum: REJECTION_CODES, description: 'Rejected only: why.' })
  code?: string;

  @ApiPropertyOptional({ description: 'Rejected only: the reason, for people.' })
  message?: string;

  @ApiPropertyOptional({
    description:
      'Rejected only, for some codes: STATUS_CONFLICT { current, allowed }, INVALID_TRANSITION { from, to, allowed }, ' +
      'NEGATIVE_QUANTITY { quantity, delta }, FIELD_CONFLICT { fields: [{ field, current, yours }] }.',
    type: 'object',
    additionalProperties: true,
  })
  details?: Record<string, unknown>;
}

export class PushResponseDto {
  @ApiProperty({ type: [MutationResultDto], description: 'One result per mutation, in order.' })
  results!: MutationResultDto[];

  @ApiProperty({ description: 'The last mutation id the server handled for the client.' })
  lastMutationId!: number;
}

export class ChangeDto {
  @ApiProperty()
  version!: number;

  @ApiProperty({ enum: ['ticket', 'part'] })
  entity!: string;

  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  siteId!: string;

  @ApiProperty({ enum: ['put', 'del'] })
  op!: string;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true, description: 'The row; null for del.' })
  data!: Record<string, unknown> | null;
}

export class PullResponseDto {
  @ApiProperty({ type: [ChangeDto] })
  changes!: ChangeDto[];

  @ApiProperty({ description: 'The cursor for the next pull.' })
  nextCursor!: number;

  @ApiProperty({ description: 'True when changes follow this page.' })
  hasMore!: boolean;

  @ApiProperty({ description: 'The last mutation id the server handled for clientId (0 without one).' })
  lastMutationId!: number;

  @ApiProperty({
    description:
      'Head of the change log in the snapshot this page was read from (lastMutationId is from the same one). ' +
      'Pull until the cursor reaches the head of the first page, then stop until the next sync.',
  })
  head!: number;
}

export class SnapshotRowDto {
  @ApiProperty({ enum: ['ticket', 'part'] })
  entity!: string;

  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  siteId!: string;

  @ApiProperty({ type: 'object', additionalProperties: true, description: 'The row.' })
  data!: Record<string, unknown>;
}

export class SnapshotKeyDto {
  @ApiProperty({ format: 'uuid' })
  siteId!: string;

  @ApiProperty({ enum: ['ticket', 'part'] })
  entity!: string;

  @ApiProperty({ format: 'uuid' })
  id!: string;
}

export class SnapshotPageDto {
  @ApiProperty({
    description: 'Head of the change log when the snapshot started; pull from it after the last page.',
  })
  watermark!: number;

  @ApiProperty({
    description:
      'Head of the change log when this page was read; no row of the page holds a later change. After pulling ' +
      'the log up to the highest head of the pages, the rows and the log are one state of the server.',
  })
  head!: number;

  @ApiProperty({ type: [SnapshotRowDto], description: "Live rows of the user's sites, ordered by siteId, entity, id." })
  rows!: SnapshotRowDto[];

  @ApiProperty({
    type: SnapshotKeyDto,
    nullable: true,
    description:
      'Key of the last row; pass it as afterSite, afterEntity, afterId for the next page. Null on the last page.',
  })
  next!: SnapshotKeyDto | null;
}

export class ClientParamsDto {
  @ApiProperty({ description: 'Id of the client installation.', format: 'uuid' })
  @IsUUID()
  clientId!: string;
}

export class RetiredClientDto {
  @ApiProperty({
    description:
      'The last mutation id the server handled under the retired id; final, since nothing more is applied under it.',
  })
  lastMutationId!: number;
}

export class ProblemDto {
  @ApiProperty({ example: 'about:blank' })
  type!: string;

  @ApiProperty({ example: 'Conflict' })
  title!: string;

  @ApiProperty({ example: 409 })
  status!: number;

  @ApiProperty({ example: 'Mutation 3 does not follow the last applied one; expected 2' })
  detail!: string;

  @ApiProperty({ enum: PROBLEM_CODES })
  code!: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, example: { expected: 2 } })
  details?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String], description: 'One message per invalid field (400).' })
  errors?: string[];
}
