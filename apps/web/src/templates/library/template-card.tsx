import { Card, ContextMenu, Button, Icon, Tag, Text, type MenuEntry } from '@nix/ui';
import { Copy, Download, LayoutTemplate, Pencil, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import type { TemplateSummary } from '../template-api';
import { TemplateViewPreview } from '../template-view-preview';

function originLabel(template: TemplateSummary): string {
  if (template.origin === 'managed') return 'Managed from file';
  if (template.origin === 'seed') return 'Built in';
  return 'Workspace';
}

export function TemplateCard({
  template,
  onUse,
  onEdit,
  onDelete,
  onDownload,
  onDuplicate,
  downloading,
  duplicating,
  duplicateDisabled,
  canDuplicate,
}: {
  readonly template: TemplateSummary;
  readonly onUse: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onDownload: () => void;
  readonly onDuplicate: () => void;
  readonly downloading: boolean;
  readonly duplicating: boolean;
  readonly duplicateDisabled: boolean;
  readonly canDuplicate: boolean;
}): ReactNode {
  const contents = [
    `${String(template.fieldCount)} ${template.fieldCount === 1 ? 'field' : 'fields'}`,
    `${String(template.viewCount)} ${template.viewCount === 1 ? 'view' : 'views'}`,
    `${String(template.childCount)} ${template.childCount === 1 ? 'item' : 'items'}`,
  ].join(' · ');
  const actions: MenuEntry[] = [];
  if (template.capabilities.canApply) {
    actions.push({ label: 'Use template', icon: LayoutTemplate, onSelect: onUse });
  }
  if (template.capabilities.canEdit) {
    actions.push({ label: 'Edit', icon: Pencil, onSelect: onEdit });
  }
  if (canDuplicate) {
    actions.push({
      label: duplicating ? 'Duplicating…' : 'Duplicate',
      icon: Copy,
      disabled: duplicateDisabled,
      onSelect: onDuplicate,
    });
  }
  if (template.capabilities.canExport) {
    actions.push({
      label: 'Download',
      icon: Download,
      disabled: downloading,
      onSelect: onDownload,
    });
  }
  if (template.capabilities.canDelete) {
    actions.push({ label: 'Delete', icon: Trash2, destructive: true, onSelect: onDelete });
  }

  return (
    <ContextMenu label={`${template.title} template actions`} items={actions}>
      {(target) => (
        <div {...target} role="group" aria-label={`${template.title} template`} className="min-w-0">
          <Card title={template.title} kicker={originLabel(template)} headingLevel={2}>
            <TemplateViewPreview templateId={template.id} title={template.title} />
            <div className="flex min-h-16 flex-col gap-3">
              <Text variant="bodySmall" tone="muted">
                {template.description ?? 'No description yet.'}
              </Text>
              <Text variant="caption" tone="muted">
                {contents}
              </Text>
              <div className="flex flex-wrap gap-1.5">
                {template.includeBody ? <Tag tone="muted">Content</Tag> : null}
                {template.includeChildren ? <Tag tone="muted">Children</Tag> : null}
                {template.viewKinds.map((kind) => (
                  <Tag key={kind}>{kind.replace('_', ' ')}</Tag>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {template.capabilities.canApply ? (
                <Button aria-label={`Use ${template.title} template`} onClick={onUse}>
                  <Icon icon={LayoutTemplate} size="sm" /> Use template
                </Button>
              ) : null}
              {template.capabilities.canEdit ? (
                <Button
                  variant="secondary"
                  aria-label={`Edit ${template.title} template`}
                  onClick={onEdit}
                >
                  <Icon icon={Pencil} size="sm" /> Edit
                </Button>
              ) : null}
              {canDuplicate ? (
                <Button
                  variant="secondary"
                  aria-label={`Duplicate ${template.title}`}
                  disabled={duplicateDisabled}
                  onClick={onDuplicate}
                >
                  <Icon icon={Copy} size="sm" /> {duplicating ? 'Duplicating…' : 'Duplicate'}
                </Button>
              ) : null}
              {template.capabilities.canExport ? (
                <Button
                  variant="icon"
                  aria-label={`Download ${template.title}`}
                  disabled={downloading}
                  onClick={onDownload}
                >
                  <Icon icon={Download} size="sm" />
                </Button>
              ) : null}
              {template.capabilities.canDelete ? (
                <Button variant="icon" aria-label={`Delete ${template.title}`} onClick={onDelete}>
                  <Icon icon={Trash2} size="sm" />
                </Button>
              ) : null}
            </div>
          </Card>
        </div>
      )}
    </ContextMenu>
  );
}
