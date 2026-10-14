import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

import { escapeHtml } from './escape.js';

/**
 * Build-time code highlighting.
 *
 * Only the core is loaded and twenty languages are registered by hand, so the renderer does not
 * carry all of highlight.js. A language outside the set, or none, is written as escaped text.
 * highlight.js escapes the code it emits; its output is class-only spans that the site
 * stylesheet colours from the syntax tokens.
 */

const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
};

for (const [name, language] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, language);
}

/** The editor's language names that differ from highlight.js's. */
const ALIASES: Readonly<Record<string, string>> = {
  sh: 'bash',
  zsh: 'bash',
  console: 'shell',
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  cs: 'csharp',
  'c#': 'csharp',
  html: 'xml',
  svg: 'xml',
  toml: 'ini',
  yml: 'yaml',
  py: 'python',
  golang: 'go',
  docker: 'dockerfile',
  md: 'markdown',
};

export function highlightCode(code: string, language: string | null): string {
  const key = language?.toLowerCase() ?? null;
  // Own keys only: the fence info string is untrusted, and `constructor` would find Object's.
  const name = key === null ? null : Object.hasOwn(ALIASES, key) ? (ALIASES[key] ?? key) : key;
  if (name === null || hljs.getLanguage(name) === undefined) {
    return escapeHtml(code);
  }
  return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
}
