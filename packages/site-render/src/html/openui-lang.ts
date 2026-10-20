import type { LanguageFn } from 'highlight.js';

/**
 * OpenUI Lang, as the Nix prompt teaches it: `name = Expression` statements, `Component(...)`
 * calls, `$state` variables, `@Step` and `@Function` calls, `//` comments, JSON-like values.
 * Token rules only; the real parser lives in the web app and is what judges a program.
 */
export const openuiLang: LanguageFn = () => ({
  name: 'OpenUI Lang',
  contains: [
    { scope: 'comment', begin: '//', end: '$' },
    { scope: 'string', begin: '"', end: '"', contains: [{ begin: '\\\\.' }] },
    { scope: 'number', begin: '-?\\b\\d+(\\.\\d+)?\\b' },
    { scope: 'literal', begin: '\\b(true|false|null)\\b' },
    // A statement's name, at the start of a line: `root`, `rows`.
    { scope: 'section', begin: '^\\s*[A-Za-z_]\\w*(?=\\s*=)' },
    { scope: 'variable', begin: '\\$[A-Za-z_]\\w*' },
    { scope: 'built_in', begin: '@[A-Za-z]\\w*' },
    // A component, Query or Mutation: a capitalised name before its parenthesis.
    { scope: 'title', begin: '\\b[A-Z]\\w*(?=\\()' },
    // An object key.
    { scope: 'attr', begin: '\\b[A-Za-z_]\\w*(?=\\s*:)' },
  ],
});
