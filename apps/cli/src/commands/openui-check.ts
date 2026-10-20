import { readFile } from 'node:fs/promises';

import { createParser, type LibraryJSONSchema } from '@openuidev/lang-core';

/** What a chat eval case expects of the generated UI in a reply (`answerChecks.openui`). */
export interface OpenUiExpectation {
  /** The reply must carry no generated UI at all. */
  readonly absent?: boolean | undefined;
  /** The reply's block must be a patch (` ```openui-lang patch `). */
  readonly patch?: boolean | undefined;
  readonly components?: readonly string[] | undefined;
  readonly mutations?: readonly string[] | undefined;
  readonly functions?: readonly string[] | undefined;
}

const BLOCK = /^```openui-lang( patch)?[^\n]*\n([\s\S]*?)^```\s*$/gm;

let schema: Promise<LibraryJSONSchema> | undefined;

/** The web's component library as JSON Schema, written beside the eval cases by the web's
 * openui-prompt.test.ts, so a reply is parsed against exactly what the app renders. */
function librarySchema(): Promise<LibraryJSONSchema> {
  schema ??= readFile(
    new URL('../../../../packages/structure-spec/evals/openui-library.json', import.meta.url),
    'utf8',
  ).then((text) => JSON.parse(text) as LibraryJSONSchema);
  return schema;
}

/** Every way the reply's generated UI falls short of the case, as failure lines. */
export async function checkOpenUi(answer: string, expected: OpenUiExpectation): Promise<string[]> {
  const blocks = [...answer.matchAll(BLOCK)].map((match) => ({
    patch: match[1] !== undefined,
    source: match[2] ?? '',
  }));
  if (expected.absent) return blocks.length > 0 ? ['reply has generated UI it should not'] : [];
  if (blocks.length === 0) return ['reply has no openui-lang block'];
  const failures: string[] = [];
  const parser = createParser(await librarySchema());
  for (const block of blocks) {
    const result = parser.parse(block.source);
    // A patch names only changed statements, so on its own it has no root; anything else counts.
    const errors = result.meta.errors.filter((error) => !(block.patch && error.code === 'no-root'));
    for (const error of errors) failures.push(`openui ${error.code}: ${error.message}`);
  }
  if (expected.patch === true && !blocks.some((block) => block.patch))
    failures.push('reply has no openui-lang patch');
  const source = blocks.map((block) => block.source).join('\n');
  for (const name of expected.components ?? [])
    if (!new RegExp(`\\b${name}\\(`).test(source)) failures.push(`openui lacks component ${name}`);
  for (const operation of expected.mutations ?? [])
    if (!source.includes(`Mutation("${operation}"`))
      failures.push(`openui lacks Mutation ${operation}`);
  for (const name of expected.functions ?? [])
    if (!source.includes(`@${name}(`)) failures.push(`openui lacks function @${name}`);
  return failures;
}
