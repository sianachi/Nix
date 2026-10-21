import { contentChangeCount, planSources } from './import-content-changes';
import type { Phase } from './import-phase';
import type { ImportPlan } from './import-plan';
import type { ImportRunReport } from './import-run';

/** What the single live region says; coarse on purpose - phases, never per-item counts. */
export function liveText(phase: Phase): string {
  switch (phase.name) {
    case 'pick':
      return phase.reading ? 'Reading the chosen files.' : '';
    case 'preview':
      return previewLiveText(phase.plan);
    case 'document-preview':
      return `Preview ready: ${String(phase.operation.itemCount ?? phase.plan.items.length)} items to import.`;
    case 'working':
      return `Importing ${String(phase.total)} items.`;
    case 'document-working':
      return `Publishing ${String(phase.total)} imported items.`;
    case 'report':
      return reportHeadline(phase.report);
    case 'document-report':
      return `${String(phase.operation.itemCount ?? phase.plan.items.length)} imported items were created.`;
  }
}

export function previewLiveText(plan: ImportPlan): string {
  const parts = [`Preview ready: ${String(plan.totalItems)} items to import.`];
  const changes = contentChangeCount(planSources(plan.root));
  if (changes > 0) {
    parts.push(
      `${String(changes)} content ${changes === 1 ? 'change needs' : 'changes need'} review.`,
    );
  }
  if (plan.skipped.length > 0) {
    parts.push(
      `${String(plan.skipped.length)} ${plan.skipped.length === 1 ? 'file will' : 'files will'} be skipped.`,
    );
  }
  if (plan.failed.length > 0) {
    parts.push(
      `${String(plan.failed.length)} ${plan.failed.length === 1 ? 'file cannot' : 'files cannot'} become notes.`,
    );
  }
  return parts.join(' ');
}

export function reportHeadline(report: ImportRunReport): string {
  if (report.couldNotStart !== undefined) {
    return 'The import could not start.';
  }
  if (report.created.length === 0) {
    return 'Nothing was imported.';
  }
  const whole =
    report.failed.length === 0 &&
    report.notAttempted.length === 0 &&
    !report.stoppedEarly &&
    !report.created.some((row) => row.bodyError !== undefined || row.propertiesError !== undefined);
  const count = `${String(report.created.length)} ${report.created.length === 1 ? 'item was' : 'items were'} created`;
  return whole ? `${count}.` : `${count}, but not everything made it across.`;
}
