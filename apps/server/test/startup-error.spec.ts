import { QueryFailedError } from 'typeorm';
import { ConfigError } from '../src/config';
import { describeStartupError } from '../src/startup-error';

describe('describeStartupError', () => {
  it('prints only the report of a configuration problem', () => {
    expect(describeStartupError(new ConfigError(['PORT must be an integer']))).toBe(
      'Invalid configuration:\n  - PORT must be an integer',
    );
  });

  it('prints a failed query without its parameters', () => {
    const err = new QueryFailedError('SELECT id FROM users WHERE token = $1', ['secret-token'], new Error('boom'));
    const text = describeStartupError(err);
    expect(text).toContain('boom');
    expect(text).not.toContain('secret-token');
  });

  it('handles values that are not errors', () => {
    expect(describeStartupError('plain')).toBe('plain');
  });
});
