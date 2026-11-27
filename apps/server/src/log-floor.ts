import { HttpStatus } from '@nestjs/common';
import { ProblemException } from './problem';

/**
 * The 410 answer for a cursor or snapshot watermark below the floor of the change log: the changes
 * after it are partly collected, so the client must reload its state from a snapshot. Not
 * retryable as it is (RFC 9110, section 15.5.11: the history after the cursor is gone for good).
 */
export function resetRequired(floor: number): ProblemException {
  return new ProblemException(
    HttpStatus.GONE,
    'RESET_REQUIRED',
    'The changes after this cursor are no longer kept; reload the state from a snapshot',
    { floor },
  );
}
