import { Button, Dialog, Icon, Text, cn, focusRing } from '@nix/ui';
import { ArrowLeft, ArrowRight, Check, Eye } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';

import { TemplateBlueprint } from './template-studio-facts';
import type { TemplateDetail } from './template-api';
import {
  TEMPLATE_STUDIO_STEPS,
  type RootTemplateFacts,
  type StudioMode,
  type TemplateDraft,
} from './template-studio-model';

export function TemplateStudioShell({
  mode,
  title,
  destination,
  step,
  working,
  previewing,
  error,
  discarding,
  draft,
  template,
  rootFacts,
  missingFactsLabel,
  stepMainRef,
  children,
  onRequestDiscard,
  onCloseDiscard,
  onDiscard,
  onTogglePreview,
  onStepChange,
  onBack,
  onNext,
  onFinish,
  finishLabel,
  finishDisabled,
}: {
  readonly mode: StudioMode;
  readonly title: string;
  readonly destination: string;
  readonly step: number;
  readonly working: boolean;
  readonly previewing: boolean;
  readonly error: string | null;
  readonly discarding: boolean;
  readonly draft: TemplateDraft;
  readonly template: TemplateDetail | null;
  readonly rootFacts: RootTemplateFacts | null;
  readonly missingFactsLabel: string | null;
  readonly stepMainRef: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
  readonly onRequestDiscard: () => void;
  readonly onCloseDiscard: () => void;
  readonly onDiscard: () => void;
  readonly onTogglePreview: () => void;
  readonly onStepChange: (index: number) => void;
  readonly onBack: () => void;
  readonly onNext: () => void;
  readonly onFinish: () => void;
  readonly finishLabel: string;
  readonly finishDisabled: boolean;
}): ReactNode {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-divider px-4 py-3">
        <Button variant="icon" aria-label="Cancel template setup" onClick={onRequestDiscard}>
          <Icon icon={ArrowLeft} size="sm" />
        </Button>
        <div className="min-w-0 flex-1">
          <Text variant="h3" as="h1" className="truncate">
            {title}
          </Text>
          <Text variant="caption" tone="muted" className="truncate">
            {mode === 'capture' || mode === 'edit'
              ? 'Shared with this workspace'
              : `Destination: ${destination}`}
          </Text>
        </div>
        <Button variant="secondary" className="lg:hidden" onClick={onTogglePreview}>
          <Icon icon={Eye} size="sm" /> {previewing ? 'Hide preview' : 'Preview'}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <nav
          aria-label="Template steps"
          className="shrink-0 border-b border-divider bg-surface p-3 lg:w-44 lg:border-b-0 lg:border-r"
        >
          <ol className="grid grid-cols-3 gap-1 lg:flex lg:flex-col lg:gap-2">
            {TEMPLATE_STUDIO_STEPS.map((entry, index) => (
              <li key={entry.label}>
                <button
                  type="button"
                  aria-current={index === step ? 'step' : undefined}
                  aria-label={`${entry.label}: ${entry.detail}`}
                  disabled={working}
                  onClick={() => {
                    onStepChange(index);
                  }}
                  className={cn(
                    `flex w-full items-center gap-2 rounded-md px-2 py-2 text-left ${focusRing}`,
                    index === step ? 'bg-accent/10 text-accent-text' : 'hover:bg-foreground/7',
                  )}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background">
                    {index < step ? <Icon icon={Check} size="sm" /> : String(index + 1)}
                  </span>
                  <span className="hidden min-w-0 lg:block">
                    <Text variant="bodySmall" as="span" className="block">
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
          <div className="mx-auto flex max-w-2xl flex-col gap-5">
            {children}
            {error === null ? null : (
              <Text variant="bodySmall" role="alert" className="bg-surface px-3 py-2">
                {error}
              </Text>
            )}
            <div className="flex items-center justify-between border-t border-divider pt-4">
              <Button variant="secondary" disabled={step === 0 || working} onClick={onBack}>
                Back
              </Button>
              {step < TEMPLATE_STUDIO_STEPS.length - 1 ? (
                <Button disabled={working} onClick={onNext}>
                  {working ? 'Checking…' : 'Continue'} <Icon icon={ArrowRight} size="sm" />
                </Button>
              ) : (
                <Button disabled={working || finishDisabled} onClick={onFinish}>
                  {working ? 'Saving…' : finishLabel}
                </Button>
              )}
            </div>
          </div>
        </main>

        <aside
          aria-label="Template preview"
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain border-t border-divider bg-surface p-4',
            'lg:flex-none lg:shrink-0 lg:border-l lg:border-t-0 lg:w-80 xl:w-96',
            previewing ? 'block' : 'hidden lg:block',
          )}
        >
          <TemplateBlueprint
            draft={draft}
            template={template}
            destination={destination}
            mode={mode}
            rootFacts={rootFacts}
            missingFactsLabel={missingFactsLabel}
          />
        </aside>
      </div>

      <Dialog
        open={discarding}
        title="Discard this setup?"
        onClose={onCloseDiscard}
        actions={
          <>
            <Button variant="secondary" onClick={onCloseDiscard}>
              Keep editing
            </Button>
            <Button disabled={working} onClick={onDiscard}>
              Discard setup
            </Button>
          </>
        }
      >
        <Text variant="bodySmall">Discarding removes this tab&rsquo;s saved draft.</Text>
      </Dialog>
    </div>
  );
}
