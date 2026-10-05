/**
 * Front matter, the flat dialect Nix imports.
 *
 * One definition shared by every import surface - the CLI and the web dialog - so `status: done`
 * means the same property either way in, and the same thing `props set status=done` writes. This
 * lives beside the Markdown mapping because front matter is Markdown's metadata: a file's body is
 * what `markdownToDocument` reads, and this is the part it must not.
 *
 * Deliberately flat, not YAML: `key: value` lines with scalar values. A line the split cannot map
 * - nested YAML, a list item, a line with no `:` or no value after it - is returned in `dropped`
 * so a mapping report can declare it per file rather than losing it silently, and the split never
 * fabricates a property the source did not have. Browser-safe by construction: no Node imports.
 */

export interface FrontMatterSplit {
  readonly properties: Record<string, unknown>;
  readonly body: string;
  /** The fence lines that could not become properties, verbatim, for the report to declare. */
  readonly dropped: readonly string[];
}

/**
 * Splits a leading `---` front matter fence into a property bag and the remaining body.
 *
 * An unclosed fence is not front matter - it is a document that starts with a rule - so the text
 * comes back untouched rather than half-swallowed as metadata.
 */
export function splitFrontMatter(text: string): FrontMatterSplit {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { properties: {}, body: text, dropped: [] };
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closing < 0) {
    return { properties: {}, body: text, dropped: [] };
  }

  const properties: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const line of lines.slice(1, closing)) {
    if (line.trim().length === 0) {
      continue;
    }
    const colon = line.indexOf(':');
    const key = colon > 0 ? line.slice(0, colon).trim() : '';
    const raw = colon > 0 ? line.slice(colon + 1).trim() : '';
    const flat =
      colon > 0 &&
      key.length > 0 &&
      raw.length > 0 &&
      !/\s/.test(key) &&
      !line.startsWith(' ') &&
      !line.startsWith('\t');
    if (!flat) {
      dropped.push(line.trim());
      continue;
    }
    properties[key] = parseScalar(raw);
  }

  return { properties, body: lines.slice(closing + 1).join('\n'), dropped };
}

/**
 * JSON where it parses (numbers, booleans, null, quoted strings), the raw text otherwise.
 *
 * The one value rule for every scalar a person hands Nix outside the editor - front matter here,
 * `props set key=value` in the CLI - so the two ways of writing a property cannot drift.
 */
export function parseScalar(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export interface NoteFromMarkdown {
  readonly title: string;
  /** The front matter values minus `title`, which the note itself consumes. */
  readonly properties: Record<string, unknown>;
  readonly body: string;
  readonly dropped: readonly string[];
}

/**
 * The one rule for what a Markdown file becomes: front matter `title` names the note when it is a
 * non-empty string (and is consumed rather than kept as a property); otherwise the file's own name
 * without its extension. Shared by the CLI and the web import so the two surfaces cannot disagree
 * about what a file becomes - the title rule is the half of that claim `splitFrontMatter` alone
 * does not carry.
 */
export function noteFromMarkdown(text: string, fileName: string): NoteFromMarkdown {
  const { properties, body, dropped } = splitFrontMatter(text);
  const titleValue = properties.title;
  const title =
    typeof titleValue === 'string' && titleValue.trim().length > 0
      ? titleValue
      : fileName.replace(/\.[^.]+$/, '');
  const rest = { ...properties };
  delete rest.title;
  return { title, properties: rest, body, dropped };
}
