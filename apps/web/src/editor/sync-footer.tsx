import {
  Check,
  CloudOff,
  CloudUpload,
  LoaderCircle,
  Lock,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { Icon, cn } from '@nix/ui';

import type { SyncState } from './collab-sync';

/**
 * The connection state, said in the terms a writer actually needs - shared by every body
 * editor, because the transport underneath them is the same one.
 *
 * Six states, none of them a spinner standing in for the others, and none of them claiming
 * more than the transport delivers: there is no local persistence, so a disconnected state
 * says the edits live in this tab and nowhere else.
 *
 * Legibility is tiered, because the states are not equally important to a person
 * mid-sentence. The line has one anatomy everywhere - glyph, a stamped uppercase term at
 * heading weight, a plain-weight detail - and the tiers move along axes the token sheet
 * already owns, since the Industry scheme is mono and carries no warning color to reach for:
 *
 *   - quiet ("live") and transitional ("connecting"): everything in the muted role, so
 *     health recedes below the document being written. Connecting is told apart by its
 *     spinning glyph, motion permitting - it is the one state that is its own progress.
 *   - unhealthy ("pending", "readonly", "degraded", "offline"): the footer takes the
 *     surface ground, the term takes full ink, and the glyph takes the base accent - the
 *     accent-glyph-plus-full-ink-heading shape the error panels in
 *     components/states/status-panels.tsx use, so trouble has one look product-wide. The
 *     accent stays off the words: within a pane, accent-colored text is the link role, and
 *     an accented word would read as clickable. Band, ink weight, glyph shape, and the
 *     words themselves each carry the distinction on their own, so it never rests on color
 *     alone.
 *
 * "Pending" sits in the unhealthy tier deliberately: it is only reachable while
 * disconnected AND holding edits the server has never seen, which is strictly worse than
 * plain offline - a footer that brightened the moment the user typed into an outage would
 * be lying with its calm, and would flicker as the reconnect loop toggled the two states.
 */

type Tier = 'quiet' | 'transitional' | 'unhealthy';

interface Presentation {
  readonly icon: LucideIcon;
  /** True only for "connecting": the one state that is its own progress. */
  readonly spins?: boolean;
  readonly term: string;
  readonly detail: string;
  readonly tier: Tier;
}

/** Exported for the test that proves every state keeps a glyph of its own. */
export const PRESENTATION: Record<SyncState, Presentation> = {
  connecting: {
    icon: LoaderCircle,
    spins: true,
    term: 'Connecting',
    detail: 'Reaching the server.',
    tier: 'transitional',
  },
  live: {
    icon: Check,
    term: 'Live',
    detail: 'Edits reach other people as you type.',
    tier: 'quiet',
  },
  pending: {
    icon: CloudUpload,
    term: 'Not saved',
    detail: 'Your edits are only in this tab until the connection returns - keep it open.',
    tier: 'unhealthy',
  },
  readonly: {
    icon: Lock,
    term: 'Read-only',
    detail: 'You have view access, so edits are not saved.',
    tier: 'unhealthy',
  },
  degraded: {
    icon: TriangleAlert,
    term: 'Not syncing',
    detail: 'The server cannot sync this document right now; reloading may help.',
    tier: 'unhealthy',
  },
  offline: {
    icon: CloudOff,
    term: 'Offline',
    detail: 'Edits made now stay only in this tab until the connection returns.',
    tier: 'unhealthy',
  },
};

export function SyncFooter({ state }: { readonly state: SyncState }): ReactNode {
  const { icon, spins, term, detail, tier } = PRESENTATION[state];
  const unhealthy = tier === 'unhealthy';

  return (
    <footer
      // Polite rather than assertive: the state changes on a timer, and an assertive region would
      // interrupt a screen-reader user mid-sentence every time it did. The region re-announces the
      // whole line on a change, so a slide into "offline" is heard, not only seen - which is why
      // this element persists across states rather than being swapped out.
      aria-live="polite"
      className={cn(
        'flex items-baseline gap-2 border-t border-divider px-8 py-2 text-xs',
        // A surface change rather than a louder border: the band itself says "this line is
        // different now" before a single word is read.
        unhealthy && 'bg-surface',
      )}
    >
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 font-heading font-semibold tracking-wider uppercase',
          // Full ink for trouble, muted otherwise: at 11px, ink value and weight are the whole
          // signal, and the muted role must stay the quieter end of it.
          unhealthy ? 'text-foreground' : 'text-muted',
        )}
      >
        {/* Decorative: no label, so the words alone carry the state for assistive technology.
            The base accent is fine on a glyph - a graphical object, not body-size text. */}
        <Icon
          icon={icon}
          size="sm"
          className={cn(unhealthy && 'text-accent', spins === true && 'motion-safe:animate-spin')}
        />
        {term}
      </span>
      {/* The title restores whatever the truncation cuts in a narrow pane; assistive tech
          already receives the full string, so this is for the sighted hover only. */}
      <span title={detail} className="min-w-0 truncate font-body text-muted">
        {detail}
      </span>
    </footer>
  );
}
