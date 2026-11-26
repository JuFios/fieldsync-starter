import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint, type Linter } from 'eslint';

/**
 * The lint rules that keep mutators deterministic are configuration, so nothing would notice if
 * they were dropped. This test lints the real mutators file with forbidden snippets appended (one
 * ESLint run: typed linting is slow) and expects each snippet to be reported by the right rule.
 */

const ROOT = resolve(__dirname, '../../..');
const FILE = resolve(ROOT, 'packages/sync-core/src/mutators.ts');

const FORBIDDEN: Array<[label: string, code: string, rule: string]> = [
  ['Math.random()', 'export const r = Math.random();', 'no-restricted-properties'],
  ['new Date()', 'export const d = new Date();', 'no-restricted-globals'],
  ['Date.now()', 'export const t = Date.now();', 'no-restricted-globals'],
  ['crypto.randomUUID()', 'export const u = crypto.randomUUID();', 'no-restricted-globals'],
  ['globalThis.crypto', 'export const g = globalThis.crypto.randomUUID();', 'no-restricted-globals'],
  ['performance.now()', 'export const p = performance.now();', 'no-restricted-globals'],
  ['setTimeout', 'setTimeout(() => undefined, 1);', 'no-restricted-globals'],
  ['an import of node:crypto', "import { randomUUID as uuidv4 } from 'node:crypto';", 'no-restricted-imports'],
];

/** Lints `text` as the mutators file with the repository's ESLint configuration (ESLint's Node.js API). */
async function lint(text: string): Promise<Linter.LintMessage[]> {
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(text, { filePath: FILE });
  if (!result) throw new Error('ESLint returned no result for the mutators file');
  return result.messages;
}

describe('mutator lint rules', () => {
  const source = readFileSync(FILE, 'utf8').replace(/\n*$/, '\n');
  const firstSnippetLine = source.split('\n').length;
  let messages: Linter.LintMessage[] = [];

  beforeAll(async () => {
    messages = await lint(`${source}${FORBIDDEN.map(([, code]) => code).join('\n')}\n`);
  }, 60_000);

  it('accept the mutators as they are', () => {
    expect(messages.filter((m) => m.line < firstSnippetLine)).toEqual([]);
  });

  it.each(FORBIDDEN.map(([label, , rule], index) => [label, rule, firstSnippetLine + index] as const))(
    'report %s',
    (_label, rule, line) => {
      expect(messages.filter((m) => m.line === line).map((m) => m.ruleId)).toContain(rule);
    },
  );
});
