import type { WorkspaceToolArgs } from '@nix/companion/tool-args';
import type { PreviewModel } from '@nix/structure-spec';

/** A value as a reader sees it in the summary table. */
function shown(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (Array.isArray(value)) return value.map(shown).join(', ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  return JSON.stringify(value);
}

/** An OpenUI Lang string literal. The parser reads string tokens with `JSON.parse`, so a
 * JSON-quoted value can never end its string early or reach the program around it. */
const quote = (text: string): string => JSON.stringify(text);

/**
 * The "at a glance" part of an approval card, as a program Nix writes from the preview it already
 * computed - never from model text - so the summary shows exactly what the card's own preview
 * says: what the change creates, and the values a property write sets. Returns null when there
 * is nothing to summarise beyond the card's preview.
 */
export function previewProgram(model: PreviewModel, args: WorkspaceToolArgs): string | null {
  const statements: string[] = [];
  const parts: string[] = [];
  const counts = (
    [
      ['Items', model.counts.items],
      ['Fields', model.counts.fields],
      ['Views', model.counts.views],
      ['Entries', model.counts.entries],
    ] as const
  ).filter(([, count]) => count > 0);
  if (counts.length > 0) {
    const names = counts.map((_, index) => `c${String(index)}`);
    statements.push(`counts = Row([${names.join(', ')}])`);
    counts.forEach(([label, count], index) => {
      statements.push(`${names[index] ?? ''} = Stat(${quote(label)}, ${String(count)})`);
    });
    parts.push('counts');
  }
  if (args.operation === 'set_properties') {
    let values: unknown;
    try {
      values = JSON.parse(args.propertiesJson);
    } catch {
      values = undefined;
    }
    if (typeof values === 'object' && values !== null && !Array.isArray(values)) {
      const rows = Object.entries(values as Record<string, unknown>).map(
        ([key, value]) => `[${quote(key)}, ${quote(shown(value))}]`,
      );
      if (rows.length > 0) {
        statements.push(
          `values = Table(["Field", "New value"], [${rows.join(', ')}], "Values this change sets")`,
        );
        parts.push('values');
      }
    }
  }
  if (parts.length === 0) return null;
  return [`root = Stack([${parts.join(', ')}])`, ...statements].join('\n');
}
