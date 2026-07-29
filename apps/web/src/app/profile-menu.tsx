import { Icon, focusRing } from '@nix/ui';
import { ChevronDown, LogOut, ShieldCheck, User } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { useAuth } from '../auth/auth-provider';
import { ThemeChoice } from '../theme/theme-choice';
import type { CurrentPrincipalState } from '../session/use-current-principal';

/**
 * The profile menu, top right: who you are, and the things that belong to you rather than to the
 * document you are looking at.
 *
 * **The administrative entry is gated on the server's answer, not on a token claim.** Roles live
 * in the database and never in tokens, so the browser cannot decide this by decoding what it
 * already holds - it asks, and until the answer arrives the entry is simply absent. Absent is the
 * honest default: showing it optimistically would put a door in front of people who cannot open
 * it, and hiding it after the fact would make the menu flicker.
 *
 * Hiding the entry is not access control and is not pretending to be. Every administrative
 * endpoint asks the database the same question for itself.
 */

export interface ProfileMenuProps {
  readonly principal: CurrentPrincipalState;
}

export function ProfileMenu({ principal }: ProfileMenuProps): ReactNode {
  const { signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: MouseEvent): void {
      if (containerRef.current?.contains(event.target as Node) === false) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const name = principal.principal?.displayName ?? 'Loading…';
  const isAdministrator = principal.principal?.isTenantAdministrator ?? false;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => {
          setOpen((current) => !current);
        }}
        className={[
          'flex items-center gap-1.5 border border-transparent px-2 py-1',
          'text-xs text-muted',
          `hover:bg-foreground/7 ${focusRing}`,
        ].join(' ')}
      >
        <Icon icon={User} size="sm" />
        <span className="max-w-[16ch] truncate">{name}</span>
        <Icon icon={ChevronDown} size="sm" />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 z-20 mt-1 w-[240px] border border-divider bg-background shadow-md"
        >
          <div className="border-b border-divider px-3 py-2">
            <p className="truncate text-base text-foreground">{name}</p>
            {/* Absent rather than blank: a machine identity has no address, and an empty line
                where one should be reads as a bug. */}
            {principal.principal?.email === null ||
            principal.principal?.email === undefined ? null : (
              <p className="truncate text-xs text-muted">{principal.principal.email}</p>
            )}
            {principal.status === 'error' ? (
              <p role="alert" className="mt-1 text-xs text-muted">
                {principal.error}
              </p>
            ) : null}
          </div>

          {isAdministrator ? (
            <Link
              role="menuitem"
              to="/settings/audit"
              onClick={() => {
                setOpen(false);
              }}
              className="flex items-center gap-2 px-3 py-2 text-base text-foreground hover:bg-accent/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              <Icon icon={ShieldCheck} size="sm" />
              Admin · Audit
            </Link>
          ) : null}

          {/* Appearance sits with the account rather than in a settings page: it belongs to the
              person rather than to the workspace, and it is the kind of thing somebody changes on
              impulse and wants immediately, not after a navigation. */}
          <ThemeChoice />

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-base text-foreground hover:bg-accent/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <Icon icon={LogOut} size="sm" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
