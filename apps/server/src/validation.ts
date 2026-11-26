import { applyDecorators } from '@nestjs/common';
import { Transform, type TransformFnParams } from 'class-transformer';
import { IsInt, Max, Min, type ValidationOptions } from 'class-validator';

/** Values from the environment or a query string arrive as strings, possibly padded with spaces. */
export function trimmed(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Converts decimal integer strings only. Anything else ("1h", "1e4", "0x10", "2.5", "", a repeated
 * query parameter) is left as it is and fails `@IsInt`, unlike `enableImplicitConversion` or
 * `@Type(() => Number)`, which would turn "1e4" into 10000 and "" into 0.
 */
export function ToInteger(): PropertyDecorator {
  return Transform(({ value }: TransformFnParams) => {
    const v = trimmed(value);
    return typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
  });
}

/**
 * A decimal integer from `min` to `max`: {@link ToInteger} with `@IsInt`, `@Min` and `@Max` sharing one
 * message, so a bad value is reported once. Composed with `applyDecorators` (NestJS custom decorators).
 */
export function IntegerIn(
  min: number,
  max: number,
  options: Pick<ValidationOptions, 'message'> = {},
): PropertyDecorator {
  const message = options.message ?? `$property must be an integer from ${min} to ${max}`;
  return applyDecorators(ToInteger(), IsInt({ message }), Min(min, { message }), Max(max, { message }));
}
