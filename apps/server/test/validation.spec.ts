import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { IntegerIn } from '../src/validation';

class Sample {
  @IntegerIn(0, 500)
  value!: number;
}

function check(value: unknown): { value: unknown; problems: string[] } {
  const sample = plainToInstance(Sample, { value });
  const problems = validateSync(sample, { stopAtFirstError: true }).flatMap((e) => Object.values(e.constraints ?? {}));
  return { value: sample.value, problems };
}

describe('IntegerIn', () => {
  it.each([
    ['0', 0],
    ['500', 500],
    [' 42 ', 42],
    [7, 7],
  ])('converts %j to the integer %d', (input, expected) => {
    expect(check(input)).toEqual({ value: expected, problems: [] });
  });

  it.each([['1e3'], ['0x10'], ['1.5'], [''], ['abc'], [['1', '2']], [null], [true], ['501'], ['-1'], [1.5]])(
    'rejects %j with one message',
    (input) => {
      expect(check(input).problems).toEqual(['value must be an integer from 0 to 500']);
    },
  );

  it('uses the message it is given', () => {
    class Custom {
      @IntegerIn(1, 2, { message: 'custom' })
      value!: number;
    }
    const errors = validateSync(plainToInstance(Custom, { value: '9' }), { stopAtFirstError: true });
    expect(errors.flatMap((e) => Object.values(e.constraints ?? {}))).toEqual(['custom']);
  });
});
