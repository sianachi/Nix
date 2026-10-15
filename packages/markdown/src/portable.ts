import type { ItemBundle } from '@nix/export';
import { escapeInline } from './to-markdown.js';

/** Static alternatives use only the already-authorized archive snapshot. */
export function portableBody(body: unknown): string {
  if (body === null) return '';
  const envelope = record(body);
  if ('sheet' in envelope) {
    const cells = record(record(envelope.sheet).cells);
    return `## Spreadsheet\n\nCell contents, including formulas as written.\n\n${fields(cells) || 'Empty spreadsheet.\n'}`;
  }
  if ('canvas' in envelope) {
    const elements = record(record(envelope.canvas).elements);
    const shown = Object.entries(elements)
      .sort(([left], [right]) => left.localeCompare(right))
      .filter(([, element]) => record(element).isDeleted !== true)
      .map(([id, value]) => {
        const element = record(value);
        const selected = Object.fromEntries(
          [
            'text',
            'originalText',
            'x',
            'y',
            'width',
            'height',
            'angle',
            'link',
            'strokeColor',
            'backgroundColor',
            'fillStyle',
            'fontSize',
            'startBinding',
            'endBinding',
            'points',
            'customData',
          ]
            .filter((key) => key in element)
            .map((key) => [key, element[key]]),
        );
        return `### ${literal(display(element.type))} ${literal(id)}\n\n${fields(selected)}`;
      });
    return `## Canvas\n\nStatic element inventory with text, geometry and connections.\n\n${shown.join('\n') || 'Empty canvas.\n'}`;
  }
  return `## Content\n\nReadable representation of this body's stored fields.\n\n${fields(envelope)}`;
}

export function portableStructure(bundle: ItemBundle): string {
  const parts: string[] = [];
  const properties = fields(bundle.properties);
  if (properties) parts.push(`## Properties\n\n${properties}`);
  if (bundle.schema?.properties.length) {
    parts.push('## Fields\n');
    for (const property of bundle.schema.properties) {
      parts.push(`### ${literal(property.label)}\n\n${fields(record(property))}`);
    }
  }
  if (bundle.type === 'file') {
    parts.push(
      `## Attachment\n\n[${literal(bundle.title)}](nix://item/${bundle.id})\n\nOpen the original attachment in Nix.`,
    );
  }
  if (bundle.views !== null && bundle.views.views.length > 0) {
    parts.push('## Views\n');
    for (const view of bundle.views.views) {
      parts.push(`### ${literal(view.name)} (${literal(view.kind.replaceAll('_', ' '))})\n`);
      if (view.columns.length) parts.push(`Fields: ${literal(view.columns.join(', '))}\n`);
      if (view.groupBy) parts.push(`Group by: ${literal(view.groupBy)}\n`);
      if (view.dateProperty) parts.push(`Date field: ${literal(view.dateProperty)}\n`);
      if (view.filters?.length) parts.push(`Saved filters: ${literal(display(view.filters))}\n`);
      if (view.interactiveForm) {
        parts.push('Static form. All pages and conditional fields are shown.\n');
        for (const page of view.interactiveForm.pages) {
          parts.push(`#### ${literal(page.title)}\n`);
          if (page.description) parts.push(literal(page.description));
          for (const block of page.blocks) {
            parts.push(`- ${literal(block.text)}${block.required ? ' (required)' : ''}`);
            if (block.help) parts.push(`  ${literal(block.help)}`);
            if (block.visibleWhen.length)
              parts.push(`  Conditions: ${literal(display(block.visibleWhen))}`);
          }
        }
      }
    }
    parts.push(
      '### Source records\n',
      'Static snapshot of accessible children. Saved queries, filters, chart calculations, habit check-in history and live controls are not evaluated here.\n',
    );
    if (!bundle.viewRows.length) parts.push('No accessible source records were included.\n');
    for (const row of bundle.viewRows) {
      parts.push(
        `#### ${literal(row.title)}\n\n[Open source](nix://item/${row.id})\n\n${fields(row.properties)}`,
      );
    }
    if (bundle.viewRowsTruncated) {
      parts.push(
        'Source records are incomplete: the export limit was reached or some records were unavailable.\n',
      );
    }
  }
  return parts.join('\n');
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function keys(value: Record<string, unknown>): string[] {
  return Object.keys(value)
    .filter((key) => !key.startsWith('$') && !key.startsWith('_nix'))
    .sort();
}

function fields(value: Record<string, unknown>): string {
  return keys(value)
    .map((key) => `- ${literal(key)}: ${literal(display(value[key]))}\n`)
    .join('');
}

function display(value: unknown, depth = 0): string {
  if (depth > 64) return '[Value exceeds nesting limit]';
  if (value === null || value === undefined) return 'Unset';
  if (Array.isArray(value))
    return value.map((entry: unknown) => display(entry, depth + 1)).join('; ');
  if (typeof value === 'object') {
    const object = record(value);
    return keys(object)
      .map((key) => `${key}: ${display(object[key], depth + 1)}`)
      .join('; ');
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  )
    return String(value);
  return '[Unsupported value]';
}

function literal(value: string): string {
  return escapeInline(value)
    .replace(/[<>_~]/g, '\\$&')
    .replace(/\r?\n/g, '\n    ')
    .replace(/^(\s*)([#>+-]|\d+\.)/gm, '$1\\$2');
}
