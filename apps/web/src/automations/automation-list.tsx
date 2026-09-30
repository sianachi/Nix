import type { AutomationRuleResponse as AutomationRule } from '@nix/api-client';
import { Checkbox, Text, cn, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { formatRelativeTime } from '../lib/date-format';
import { describeDisabledReason, draftFromRule, summarizeTrigger } from './automation-draft';

/**
 * The caller's rules, one row each: what sets it off, whether it is on, when it last ran, and -
 * when Core turned it off itself - why, said on the row rather than left for somebody to notice.
 *
 * The name is a link rather than a button because opening a rule is navigation: the address says
 * which rule is open, so it survives a refresh and can be shared with oneself on another device.
 */

export interface AutomationListProps {
  readonly rules: readonly AutomationRule[];
  readonly hrefFor: (rule: AutomationRule) => string;
  readonly onToggle: (rule: AutomationRule, enabled: boolean) => void;
  /** Rules with a toggle in flight. */
  readonly pending: ReadonlySet<string>;
  /** A refused toggle's reason, by rule id, shown on that rule's row. */
  readonly toggleErrors: Readonly<Record<string, string>>;
  readonly now?: Date;
}

export function AutomationList(props: AutomationListProps): ReactNode {
  const { rules, hrefFor, onToggle, pending, toggleErrors, now = new Date() } = props;
  return (
    <ul aria-label="Your automations" className="flex flex-col gap-3">
      {rules.map((rule) => {
        const editable = draftFromRule(rule) !== null;
        const toggleError = toggleErrors[rule.id];
        return (
          <li key={rule.id} className="flex flex-col gap-2 border border-divider p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <Link
                  to={hrefFor(rule)}
                  className={cn(
                    'min-w-0 truncate font-heading text-foreground underline-offset-2 hover:underline',
                    focusRing,
                  )}
                >
                  {rule.name}
                </Link>
                <Text variant="note" tone="muted">
                  {summarizeTrigger(rule.trigger)}
                </Text>
                <Text variant="caption" as="p" tone="muted">
                  {rule.lastRunAt === null
                    ? 'Has not run yet'
                    : `Last ran ${formatRelativeTime(new Date(rule.lastRunAt), now)}`}
                </Text>
              </div>
              <div className="flex items-center gap-3">
                <Checkbox
                  label="On"
                  aria-label={`Turn on ${rule.name}`}
                  checked={rule.enabled}
                  disabled={!editable || pending.has(rule.id)}
                  onChange={(event) => {
                    onToggle(rule, event.currentTarget.checked);
                  }}
                />
              </div>
            </div>
            {!rule.enabled && rule.disabledReason !== null ? (
              <Text variant="note" role="status" tone="accent">
                {describeDisabledReason(rule.disabledReason)}
              </Text>
            ) : null}
            {editable ? null : (
              <Text variant="note" tone="muted">
                This automation uses settings this version of Nix cannot edit. Open it to see its
                run log or delete it.
              </Text>
            )}
            {toggleError === undefined ? null : (
              <Text variant="note" role="alert">
                {toggleError}
              </Text>
            )}
          </li>
        );
      })}
    </ul>
  );
}
