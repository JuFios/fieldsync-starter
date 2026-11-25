import { ConfigError } from './config';

/**
 * Text to print when the process cannot start. A configuration problem is the operator's to fix,
 * so only its report is shown. For anything else the message and stack are shown, never the error
 * object itself: database driver errors carry the failed query's parameters as properties.
 */
export function describeStartupError(err: unknown): string {
  if (err instanceof ConfigError) return err.message;
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}
