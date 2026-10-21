import { type PetToolCall } from '@nix/api-client';
import type { WorkspaceToolArgs } from '@nix/companion/tool-args';
import { Button, Card, Text, cn, focusRing } from '@nix/ui';
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { ApprovalSummary } from '../approval/approval-summary';
import { EditRequest, isEditable, type EditedRequest } from '../approval/edit-request';
import type { PreparedPreview } from '../approval/prepare-write';
import { PropertyValueList, WriteTextSection } from '../approval/write-text';
import type { writeTextItems } from '../approval/write-gate';
import { PetBodyEditPreview } from '../pet-body-edit-preview';
import { PetStructurePreview } from '../pet-structure-preview';
import type { Resolver } from './activity-rows';

/** The card a write wears while it waits for its first real decision. */
export function PendingWriteCard({
  tool,
  submitted,
  busy,
  workspaceId,
  supported,
  args,
  originalArgs,
  model,
  previewCurrent: currentPreview,
  previewLoading,
  previewError,
  fingerprint,
  problemCount,
  progress,
  itemId,
  parentId,
  textItems,
  waitReason,
  cleanup,
  edit,
  editing,
  onEdit,
  onEditing,
  onBuildProgress,
  onResolve,
}: {
  readonly tool: PetToolCall;
  readonly submitted: string | undefined;
  readonly busy: boolean;
  readonly workspaceId: string;
  readonly supported: boolean;
  readonly args: WorkspaceToolArgs | undefined;
  readonly originalArgs: WorkspaceToolArgs | undefined;
  readonly model: PreparedPreview['model'] | undefined;
  readonly previewCurrent: boolean;
  readonly previewLoading: boolean;
  readonly previewError: string | undefined;
  readonly fingerprint: PreparedPreview['fingerprint'] | undefined;
  readonly problemCount: number;
  readonly progress: string | undefined;
  readonly itemId: string | undefined;
  readonly parentId: string | undefined;
  readonly textItems: ReturnType<typeof writeTextItems>;
  readonly waitReason: string | undefined;
  readonly cleanup: ReactElement | null;
  readonly edit: EditedRequest | null;
  readonly editing: boolean;
  readonly onEdit: (edit: EditedRequest | null) => void;
  readonly onEditing: (editing: boolean) => void;
  readonly onBuildProgress: (message: string) => void;
  readonly onResolve: Resolver;
}): ReactElement {
  return (
    <Card title={supported ? 'Approve this change?' : 'Unsupported tool request'} headingLevel={3}>
      {model && args ? (
        <ApprovalSummary model={model} args={args} workspaceId={workspaceId} />
      ) : null}
      {model ? (
        <PetStructurePreview
          model={model}
          captureSummary={args?.operation === 'save_as_template'}
          // Security fix S1: a pending card never folds any part of the tree it is being asked
          // to approve - "Show N more", "Why", and warnings all stay open. Folding is fine again
          // once the write has an outcome, on `WriteReceiptRow`'s own receipt.
          pending
        >
          {model.bodyEdit ? <PetBodyEditPreview edit={model.bodyEdit} /> : null}
        </PetStructurePreview>
      ) : null}
      {!currentPreview || previewLoading ? (
        <Text variant="note">Preparing the preview...</Text>
      ) : null}
      {progress ? (
        <Text variant="note" role="status">
          {progress}
        </Text>
      ) : null}
      {currentPreview && previewError ? (
        <Text variant="note" role="alert">
          {previewError}
        </Text>
      ) : null}
      {!supported ? (
        <Text variant="note">
          This request is unsupported. Decline it so the companion can try a supported operation.
        </Text>
      ) : null}
      {args?.operation === 'set_properties' ? (
        <PropertyValueList propertiesJson={args.propertiesJson} />
      ) : null}
      <WriteTextSection items={textItems} />
      {itemId ? (
        <Link className={cn('underline', focusRing)} to={`/w/${workspaceId}?item=${itemId}`}>
          Inspect target item
        </Link>
      ) : null}
      {parentId ? (
        <Link className={cn('underline', focusRing)} to={`/w/${workspaceId}?item=${parentId}`}>
          Inspect destination
        </Link>
      ) : null}
      <Text variant="note" tone="muted">
        Approval applies this change using your Nix permissions.
      </Text>
      {waitReason ? (
        <Text variant="note" tone="muted">
          {waitReason}
        </Text>
      ) : null}
      {cleanup}
      {edit !== null ? (
        <Text variant="note" role="status">
          You edited this request. The preview above shows the edited version.
        </Text>
      ) : null}
      {editing && originalArgs ? (
        <EditRequest
          original={originalArgs}
          current={args ?? originalArgs}
          onSave={(edited) => {
            onEdit(edited);
            onEditing(false);
          }}
          onCancel={() => {
            onEditing(false);
          }}
        />
      ) : null}
      {tool.status === 'pending' && !submitted ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={
              editing ||
              busy ||
              !supported ||
              !currentPreview ||
              previewLoading ||
              !model ||
              problemCount > 0 ||
              Boolean(previewError)
            }
            onClick={() => {
              const isBuild = args?.operation === 'build_blueprint';
              if (isBuild) onBuildProgress('Building the draft...');
              void onResolve(
                tool,
                true,
                currentPreview ? fingerprint : undefined,
                undefined,
                isBuild
                  ? (completed, total) => {
                      onBuildProgress(`Building ${String(completed)} of ${String(total)}...`);
                    }
                  : undefined,
                false,
                false,
                edit ?? undefined,
              );
            }}
          >
            Approve request
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              void onResolve(tool, false);
            }}
          >
            Decline request
          </Button>
          {originalArgs && isEditable(originalArgs) && !editing ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                onEditing(true);
              }}
            >
              {edit === null ? 'Edit before approving' : 'Edit again'}
            </Button>
          ) : null}
          {edit !== null && !editing ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                onEdit(null);
              }}
            >
              Undo my edits
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
