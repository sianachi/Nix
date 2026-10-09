import { cn, Text } from '@nix/ui';
import type { ReactNode } from 'react';

import { formatMeasure } from './chart-model';

/** One column of a chart's table: a series as drawn, or a derived line. */
export interface ChartTableColumn {
  readonly key: string;
  readonly label: string;
  readonly values: readonly (number | null)[];
}

export interface ChartTableProps {
  readonly caption: string;
  /** What the first column is: the grouping property, or the period. */
  readonly rowHeader: string;
  readonly rows: readonly {
    readonly key: string;
    readonly label: string;
    readonly muted?: boolean;
  }[];
  readonly columns: readonly ChartTableColumn[];
}

/**
 * Every figure a chart draws, as a table.
 *
 * **The drawing is decoration over this, never the other way round.** Column, pie, line and area
 * charts are SVG marked `aria-hidden`; their numbers live here, as text, so a screen reader reads
 * figures rather than a description of a picture and a copy-paste carries data. Visible rather than
 * hidden for the same reason - a person checking one value should not have to estimate it from a
 * line's height.
 *
 * Scrolls sideways inside itself when a chart has many series, so a phone never scrolls the page.
 */
export function ChartTable({ caption, rowHeader, rows, columns }: ChartTableProps): ReactNode {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="p-1 text-left font-normal">
              <Text variant="note" tone="muted" as="span">
                {rowHeader}
              </Text>
            </th>
            {columns.map((column) => (
              <th key={column.key} scope="col" className="p-1 text-right font-normal">
                <Text variant="note" tone="muted" as="span" className="whitespace-nowrap">
                  {column.label}
                </Text>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.key} className="border-b border-divider">
              <th scope="row" className="p-1 text-left font-normal">
                <Text
                  as="span"
                  variant="bodySmall"
                  tone={row.muted === true ? 'muted' : 'default'}
                  className="whitespace-nowrap"
                >
                  {row.label}
                </Text>
              </th>
              {columns.map((column) => (
                <td key={column.key} className={cn('whitespace-nowrap p-1 text-right')}>
                  <Text as="span" variant="bodySmall">
                    {formatMeasure(column.values[index] ?? null)}
                  </Text>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
