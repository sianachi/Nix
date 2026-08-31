import { Blueprint, Tag, Text } from '@nix/ui';
import type { ReactNode } from 'react';

import type { TemplateDetail, TemplatePreflight } from './template-api';
import type { RootTemplateFacts, StudioMode, TemplateDraft } from './template-studio-model';

export function Review({
  mode,
  draft,
  template,
  preflight,
  destination,
  rootFacts,
  missingFactsLabel,
}: {
  readonly mode: StudioMode;
  readonly draft: TemplateDraft;
  readonly template: TemplateDetail | null;
  readonly preflight: TemplatePreflight | null;
  readonly destination: string;
  readonly rootFacts: RootTemplateFacts | null;
  readonly missingFactsLabel: string | null;
}): ReactNode {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Text variant="h2" as="h2">
          Review
        </Text>
        <Text variant="bodySmall" tone="muted">
          Nothing changes until you finish.
        </Text>
      </div>
      <TemplateBlueprint
        draft={draft}
        template={template}
        destination={destination}
        mode={mode}
        rootFacts={rootFacts}
        missingFactsLabel={missingFactsLabel}
      />
      {preflight === null ? null : (
        <Blueprint className="flex flex-col gap-2 p-4">
          <TemplateFact label="Fields added" value={String(preflight.additions.fields)} />
          <TemplateFact label="Views added" value={String(preflight.additions.views)} />
          <TemplateFact label="Items added" value={String(preflight.additions.items)} />
          {preflight.conflicts.map((conflict) => (
            <Text key={conflict} variant="bodySmall" role="alert">
              {conflict}
            </Text>
          ))}
        </Blueprint>
      )}
      {mode === 'edit' ? (
        <Text variant="caption" tone="muted">
          The active template stays unchanged until Save completes every draft change together.
        </Text>
      ) : null}
    </section>
  );
}

export function TemplateBlueprint({
  draft,
  template,
  destination,
  mode,
  rootFacts,
  missingFactsLabel,
}: {
  readonly draft: TemplateDraft;
  readonly template: TemplateDetail | null;
  readonly destination: string;
  readonly mode: StudioMode;
  readonly rootFacts: RootTemplateFacts | null;
  readonly missingFactsLabel: string | null;
}): ReactNode {
  return (
    <Blueprint className="flex flex-col gap-4 p-4">
      <div>
        <Text variant="kicker">Template blueprint</Text>
        <Text variant="h3">{draft.title || 'Untitled template'}</Text>
        {draft.description ? (
          <Text variant="bodySmall" tone="muted">
            {draft.description}
          </Text>
        ) : null}
      </div>
      <TemplateFacts
        template={template}
        fallback={draft}
        mode={mode}
        rootFacts={rootFacts}
        missingFactsLabel={missingFactsLabel}
      />
      <div className="border-t border-divider pt-3">
        <TemplateFact label="Destination" value={destination} />
      </div>
    </Blueprint>
  );
}

export function TemplateFacts({
  template,
  fallback,
  mode,
  rootFacts = null,
  missingFactsLabel = null,
}: {
  readonly template: TemplateDetail | null;
  readonly fallback?: TemplateDraft;
  readonly mode?: StudioMode;
  readonly rootFacts?: RootTemplateFacts | null;
  readonly missingFactsLabel?: string | null;
}): ReactNode {
  const fieldCount = rootFacts?.fieldCount ?? template?.fieldCount;
  const viewCount = rootFacts?.viewCount ?? template?.viewCount;
  const viewKinds = rootFacts?.viewKinds ?? template?.viewKinds ?? [];
  return (
    <div className="flex flex-col gap-2">
      <TemplateFact label="Fields" value={fieldCount?.toString() ?? missingFactsLabel ?? '0'} />
      <TemplateFact label="Views" value={viewCount?.toString() ?? missingFactsLabel ?? '0'} />
      <TemplateFact
        label="Children"
        value={
          template?.includeChildren === true || fallback?.includeChildren === true
            ? String(template?.childCount ?? 'Included')
            : 'Not included'
        }
      />
      <TemplateFact
        label="Content"
        value={
          template?.includeBody === true || fallback?.includeBody === true
            ? mode === 'apply'
              ? 'New items only'
              : 'Included'
            : 'Not included'
        }
      />
      {viewKinds.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">
          {viewKinds.map((kind) => (
            <Tag key={kind}>{kind.replace('_', ' ')}</Tag>
          ))}
        </div>
      )}
    </div>
  );
}

export function TemplateFact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="bodySmall" className="text-right">
        {value}
      </Text>
    </div>
  );
}
