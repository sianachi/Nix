import { Button, Dialog, Icon, Text, cn, focusRing } from '@nix/ui';
import { ArrowLeft, ArrowRight, Check, Eye } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import type { PropertyDefinition } from '../core/container-model';
import {
  STEPS,
  validateDraft,
  validateStep,
  type StudioDraft,
  type StudioIntent,
} from './creation-studio-model';
import type { StructuredRecipe } from './structured-recipes';
import { StudioPreview } from './creation-studio-preview';

export function CreationStudioFrame({
  recipe,
  itemId,
  viewId,
  destination,
  intent,
  step,
  draft,
  existingProperties,
  previewing,
  saving,
  error,
  discarding,
  onStepChange,
  onError,
  onPreviewToggle,
  onCancel,
  onFinish,
  onDiscardClose,
  onDiscard,
  children,
}: {
  readonly recipe: StructuredRecipe;
  readonly itemId: string | undefined;
  readonly viewId: string | undefined;
  readonly destination: string;
  readonly intent: StudioIntent;
  readonly step: number;
  readonly draft: StudioDraft;
  readonly existingProperties: readonly PropertyDefinition[];
  readonly previewing: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly discarding: boolean;
  readonly onStepChange: (step: number) => void;
  readonly onError: (error: string | null) => void;
  readonly onPreviewToggle: () => void;
  readonly onCancel: () => void;
  readonly onFinish: () => void;
  readonly onDiscardClose: () => void;
  readonly onDiscard: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const stepMainRef = useRef<HTMLElement>(null);
  const previousStep = useRef(step);

  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    const heading = stepMainRef.current?.querySelector<HTMLElement>('h2');
    if (heading === null || heading === undefined) return;
    heading.tabIndex = -1;
    heading.focus();
  }, [step]);

  function focusFirstField(): void {
    queueMicrotask(() => {
      stepMainRef.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    });
  }

  function goToStep(nextStep: number): void {
    if (nextStep <= step) {
      onError(null);
      onStepChange(nextStep);
      return;
    }

    for (let candidate = step; candidate < nextStep; candidate += 1) {
      const reason = validateStep(candidate, draft, existingProperties);
      if (reason !== null) {
        onStepChange(candidate);
        onError(reason);
        focusFirstField();
        return;
      }
    }

    onError(null);
    onStepChange(nextStep);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-divider px-4 py-3">
        <Button variant="icon" aria-label="Cancel guided setup" onClick={onCancel}>
          <Icon icon={ArrowLeft} size="sm" />
        </Button>
        <div className="min-w-0 flex-1">
          <Text variant="h2" as="h1" className="truncate">
            {itemId === undefined
              ? `New ${recipe.label}`
              : viewId === undefined
                ? `Add ${recipe.label} view`
                : `Edit ${recipe.label}`}
          </Text>
          <Text variant="note" tone="muted" className="mt-0.5 block truncate">
            {itemId === undefined
              ? `Creating in ${destination}`
              : viewId === undefined
                ? `Adding to ${destination}`
                : `Editing in ${destination}`}
          </Text>
        </div>
        <Button variant="secondary" className="lg:hidden" onClick={onPreviewToggle}>
          <Icon icon={Eye} size="sm" /> {previewing ? 'Hide preview' : 'Preview'}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <nav
          aria-label="Creation steps"
          className="shrink-0 border-b border-divider bg-surface p-3 lg:w-44 lg:border-b-0 lg:border-r"
        >
          <ol className="grid grid-cols-4 gap-1 lg:flex lg:flex-col lg:gap-2">
            {STEPS.map((entry, index) => (
              <li key={entry.id}>
                <button
                  type="button"
                  aria-current={step === index ? 'step' : undefined}
                  aria-label={`${entry.label}: ${entry.detail}`}
                  onClick={() => {
                    goToStep(index);
                  }}
                  className={cn(
                    `flex w-full items-center gap-2 rounded-md px-2 py-2 text-left ${focusRing}`,
                    step === index ? 'bg-accent/10 text-accent-text' : 'hover:bg-foreground/7',
                  )}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background">
                    {index < step ? <Icon icon={Check} size="sm" /> : String(index + 1)}
                  </span>
                  <span className="hidden min-w-0 lg:block">
                    <Text variant="note" as="span" className="block">
                      {entry.label}
                    </Text>
                    <Text variant="caption" as="span" tone="muted" className="block truncate">
                      {entry.detail}
                    </Text>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <main
          ref={stepMainRef}
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6',
            previewing ? 'hidden lg:block' : '',
          )}
        >
          <div className="mx-auto flex max-w-xl flex-col gap-6">
            {children}

            {error === null ? null : (
              <Text variant="bodySmall" role="alert" className="bg-surface px-3 py-2">
                {error}
              </Text>
            )}

            <div className="flex items-center justify-between border-t border-divider pt-4">
              <Button
                variant="secondary"
                disabled={step === 0 || saving}
                onClick={() => {
                  goToStep(Math.max(0, step - 1));
                }}
              >
                Back
              </Button>
              {step < STEPS.length - 1 ? (
                <Button
                  disabled={saving}
                  onClick={() => {
                    goToStep(Math.min(STEPS.length - 1, step + 1));
                  }}
                >
                  Continue <Icon icon={ArrowRight} size="sm" />
                </Button>
              ) : (
                <Button
                  disabled={saving || validateDraft(draft, existingProperties) !== null}
                  onClick={onFinish}
                >
                  {saving
                    ? intent === 'create'
                      ? 'Creating…'
                      : intent === 'add'
                        ? 'Adding…'
                        : 'Updating…'
                    : intent === 'create'
                      ? `Create ${recipe.label}`
                      : intent === 'add'
                        ? `Add ${recipe.label}`
                        : 'Save changes'}
                </Button>
              )}
            </div>
          </div>
        </main>

        <aside
          aria-label="Live preview"
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain border-t border-divider bg-surface p-4',
            'lg:flex-none lg:shrink-0 lg:border-l lg:border-t-0 lg:w-80 xl:w-96',
            previewing ? 'block' : 'hidden lg:block',
          )}
        >
          <Text variant="note" as="div" tone="muted" className="mb-3">
            Preview
          </Text>
          <StudioPreview draft={draft} />
        </aside>
      </div>

      <Dialog
        open={discarding}
        title="Discard this setup?"
        onClose={onDiscardClose}
        actions={
          <>
            <Button variant="secondary" onClick={onDiscardClose}>
              Keep editing
            </Button>
            <Button onClick={onDiscard}>Discard setup</Button>
          </>
        }
      >
        <Text variant="bodySmall">
          {itemId === undefined
            ? 'The item has not been created yet.'
            : viewId === undefined
              ? 'The view has not been added yet.'
              : 'The existing view has not been changed yet.'}{' '}
          Discarding removes this tab&rsquo;s saved draft.
        </Text>
      </Dialog>
    </div>
  );
}
