import { Button, Text } from '@nix/ui';
import type { DocumentImport, DocumentImportPlan } from '@nix/api-client';
import type { ReactNode } from 'react';

import { ErrorPanel, PartialNotice } from '../components/states/status-panels';
import { ContentChanges } from './import-content-changes';
import { FocusOnMount } from './import-focus-on-mount';
import { distinctReasons, groupByReason, pathsClause, withoutDot } from './import-format';
import { reportHeadline } from './import-live-text';
import type { UndoState } from './import-phase';
import type { ImportRunReport } from './import-run';

export function Report({
  report,
  losses,
  undo,
  onUndo,
  onRetry,
}: {
  readonly report: ImportRunReport;
  readonly losses: readonly string[];
  readonly undo: UndoState;
  readonly onUndo: () => void;
  readonly onRetry?: (() => void) | undefined;
}): ReactNode {
  if (report.couldNotStart !== undefined) {
    return (
      <ErrorPanel
        title="The import could not start"
        detail={report.couldNotStart}
        action={
          onRetry === undefined ? undefined : (
            <Button variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          )
        }
      />
    );
  }

  if (report.created.length === 0) {
    // A run that made nothing is a refusal, not a partial: an alert, not a status beside content
    // that does not exist.
    return (
      <ErrorPanel
        title="Nothing was imported"
        detail={
          report.failed.length > 0
            ? `${withoutDot(distinctReasons(report.failed))}.`
            : (report.stopReason ??
              'The run made nothing and gave no reason - which is a bug worth reporting.')
        }
      />
    );
  }

  const lossy = report.created.filter(
    (row) => row.bodyError !== undefined || row.propertiesError !== undefined,
  );

  return (
    <>
      <FocusOnMount>
        <Text variant="body">{reportHeadline(report)}</Text>
      </FocusOnMount>
      {report.stopReason !== undefined ? (
        <PartialNotice pending={`${withoutDot(report.stopReason)}.`} />
      ) : null}
      {losses.map((loss) => (
        <PartialNotice key={loss} pending={loss} />
      ))}
      {lossy.length > 0 ? (
        <PartialNotice
          pending={`${String(lossy.length)} created ${lossy.length === 1 ? 'item' : 'items'} lost part of ${lossy.length === 1 ? 'its' : 'their'} content: ${lossy
            .map(
              (row) => `${row.title} (${withoutDot(row.bodyError ?? row.propertiesError ?? '')})`,
            )
            .join('; ')}.`}
        />
      ) : null}
      <ContentChanges sources={report.created} mode="receipt" />
      {groupByReason(report.failed).map((group) => (
        <PartialNotice
          key={`fail-${group.reason}`}
          pending={`${String(group.paths.length)} ${group.paths.length === 1 ? 'item' : 'items'} failed - ${withoutDot(group.reason)}: ${pathsClause(group.paths)}.`}
        />
      ))}
      {groupByReason(report.notAttempted).map((group) => (
        <PartialNotice
          key={`skip-${group.reason}`}
          pending={`${String(group.paths.length)} ${group.paths.length === 1 ? 'item was' : 'items were'} not attempted - ${withoutDot(group.reason)}: ${pathsClause(group.paths)}.`}
        />
      ))}
      {report.rootItemId !== null ? <UndoRow undo={undo} onUndo={onUndo} /> : null}
    </>
  );
}

export function DocumentReport({
  operation,
  plan,
  undo,
  onUndo,
}: {
  readonly operation: DocumentImport;
  readonly plan: DocumentImportPlan;
  readonly undo: UndoState;
  readonly onUndo: () => void;
}): ReactNode {
  const count = operation.itemCount ?? plan.items.length;
  return (
    <>
      <FocusOnMount>
        <Text variant="body">
          {String(count)} {count === 1 ? 'item was' : 'items were'} created.
        </Text>
      </FocusOnMount>
      {(operation.loss ?? plan.loss).map((loss) => (
        <PartialNotice key={`receipt-loss-${loss}`} pending={loss} />
      ))}
      {(operation.omissions ?? plan.omissions).map((omission) => (
        <PartialNotice key={`receipt-omission-${omission}`} pending={`Omitted: ${omission}`} />
      ))}
      <UndoRow undo={undo} onUndo={onUndo} />
    </>
  );
}

function UndoRow({
  undo,
  onUndo,
}: {
  readonly undo: UndoState;
  readonly onUndo: () => void;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" onClick={onUndo} disabled={undo.name !== 'available'}>
        {undo.name === 'working' ? 'Undoing…' : undo.name === 'done' ? 'Undone' : 'Undo import'}
      </Button>
      {undo.name === 'done' ? (
        <Text tone="muted" variant="note" as="span">
          The imported items were moved to deleted; they can be restored.
        </Text>
      ) : null}
      {undo.name === 'failed' ? (
        <div role="alert">
          <Text tone="accent" variant="note" as="span">
            {undo.error}
          </Text>
        </div>
      ) : null}
    </div>
  );
}
