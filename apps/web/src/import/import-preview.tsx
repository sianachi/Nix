import { Button, Text } from '@nix/ui';
import type { DocumentImport, DocumentImportPlan } from '@nix/api-client';
import type { ReactNode } from 'react';

import { PartialNotice } from '../components/states/status-panels';
import { ContentChanges, containers, planSources } from './import-content-changes';
import { FocusOnMount } from './import-focus-on-mount';
import { groupByReason, pathsClause, withoutDot } from './import-format';
import type { ImportPlan } from './import-plan';

export function Preview({
  plan,
  losses,
  onChooseAgain,
}: {
  readonly plan: ImportPlan;
  readonly losses: readonly string[];
  readonly onChooseAgain: () => void;
}): ReactNode {
  const root = plan.root;
  if (root === null) {
    return null;
  }
  const contentItems = plan.totalItems - containers(root);
  const sources = planSources(root);

  return (
    <>
      <FocusOnMount>
        <Text variant="body">
          {String(contentItems)} {contentItems === 1 ? 'file or note' : 'files and notes'} will be
          created under a new item called &ldquo;{root.title}&rdquo;. Nothing is created until you
          press Import.
        </Text>
      </FocusOnMount>
      {losses.map((loss) => (
        <PartialNotice key={loss} pending={loss} />
      ))}
      {groupByReason(plan.skipped).map((group) => (
        <PartialNotice
          key={`skip-${group.reason}`}
          pending={`${String(group.paths.length)} ${group.paths.length === 1 ? 'file' : 'files'} will be skipped - ${withoutDot(group.reason)}: ${pathsClause(group.paths)}.`}
        />
      ))}
      {groupByReason(plan.failed).map((group) => (
        <PartialNotice
          key={`fail-${group.reason}`}
          pending={`${String(group.paths.length)} ${group.paths.length === 1 ? 'file' : 'files'} cannot become notes - ${withoutDot(group.reason)}: ${pathsClause(group.paths)}.`}
        />
      ))}
      <ContentChanges sources={sources} mode="preview" />
      <ChooseAgain label="Choose different files" onClick={onChooseAgain} />
    </>
  );
}

export function DocumentPreview({
  operation,
  plan,
  onChooseAgain,
}: {
  readonly operation: DocumentImport;
  readonly plan: DocumentImportPlan;
  readonly onChooseAgain: () => void;
}): ReactNode {
  const titles = new Map(plan.items.map((item) => [item.sourceId, item.title]));
  const shown = plan.items.slice(0, 100);
  const remaining = plan.items.length - shown.length;
  const losses = operation.loss ?? plan.loss;
  const omissions = operation.omissions ?? plan.omissions;

  return (
    <>
      <FocusOnMount>
        <Text variant="body">
          {String(operation.itemCount ?? plan.items.length)} items will be added together under
          &ldquo;{operation.title}&rdquo;. Nothing shows until all of them are ready.
        </Text>
      </FocusOnMount>
      {losses.map((loss) => (
        <PartialNotice key={`loss-${loss}`} pending={loss} />
      ))}
      {omissions.map((omission) => (
        <PartialNotice key={`omission-${omission}`} pending={`Omitted: ${omission}`} />
      ))}
      <details className="flex flex-col gap-2">
        <summary className="min-h-(--control-md) cursor-pointer any-pointer-coarse:min-h-(--control-lg)">
          <Text variant="h5" as="h2" className="inline">
            Item mapping
          </Text>
        </summary>
        <ul className="mt-2 space-y-2">
          {shown.map((item) => (
            <li key={item.sourceId} className="rounded-md bg-surface p-3 shadow-sm">
              <Text as="span" variant="body">
                {item.title} becomes a {item.itemType}
                {item.parentSourceId === null
                  ? ' at the chosen destination'
                  : ` under ${titles.get(item.parentSourceId) ?? item.parentSourceId}`}
                {item.file === undefined ? '' : ` (${item.file.mediaType}, retained as a file)`}.
              </Text>
            </li>
          ))}
        </ul>
        {remaining > 0 ? (
          <Text tone="muted" variant="note" className="mt-2">
            {String(remaining)} more mapped items are included in the import.
          </Text>
        ) : null}
      </details>
      <ChooseAgain label="Choose a different file" onClick={onChooseAgain} />
    </>
  );
}

/** Kept out of the sticky action row so it holds only Cancel and the one primary action. */
function ChooseAgain({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <div>
      <Button variant="ghost" onClick={onClick}>
        {label}
      </Button>
    </div>
  );
}
