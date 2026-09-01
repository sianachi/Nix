import type { ExportFormat as AdvertisedExportFormat } from '@nix/api-client';

export type ExportFormat = string;
export type FormatDescriptor = AdvertisedExportFormat;

export function preferredFormat(
  formats: readonly FormatDescriptor[],
): FormatDescriptor | undefined {
  return formats.find((format) => format.lossless) ?? formats[0];
}

export function formatFor(
  formats: readonly FormatDescriptor[],
  value: ExportFormat,
): FormatDescriptor | undefined {
  return formats.find((format) => format.format === value);
}

export function formatPreamble(format: FormatDescriptor): string {
  if (format.lossless) {
    return `${format.label} is advertised as lossless. It preserves the workspace information this exporter understands so it can be brought back without a format conversion.`;
  }

  if (format.declaredLoss.length === 0) {
    return `${format.label} is a converted format. This worker did not advertise specific fidelity limits, so review the completed export report before relying on it.`;
  }

  return `${format.label} can simplify workspace content. ${format.declaredLoss.join(' ')} The completed export repeats its format limits and reports any omissions it encountered.`;
}

export function partialExportSummary(input: {
  readonly itemCount: number;
  readonly omittedCount: number;
  readonly loss: readonly string[];
  readonly omissions: readonly string[];
}): string {
  const exported = `${String(input.itemCount)} ${input.itemCount === 1 ? 'item was' : 'items were'} exported.`;
  const omitted =
    input.omittedCount === 0
      ? null
      : `${String(input.omittedCount)} ${input.omittedCount === 1 ? 'item was' : 'items were'} omitted.`;
  const detail = [...input.loss, ...input.omissions];
  const report =
    detail.length === 0
      ? null
      : `Reported changes: ${detail.slice(0, 3).join(' ')}${detail.length > 3 ? ` ${String(detail.length - 3)} more are recorded in the export result.` : ''}`;

  return [exported, omitted, report].filter((part): part is string => part !== null).join(' ');
}
