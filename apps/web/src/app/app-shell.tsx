import { type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';

import { useSessionStore } from '../auth/session-store';

/**
 * The application chrome, per the shell pattern the design language applies to every screen.
 *
 * A hairline-bordered tab strip in condensed uppercase, with a 2px accent rule under the active
 * one. The rule is the only solid accent object in the chrome - the design reserves filled accent
 * for the primary action and for exactly this indicator, so tabs are otherwise plain text on the
 * page ground.
 */

const TABS = [
  { to: '/', label: 'Editor', end: true },
  { to: '/board', label: 'Board', end: false },
  { to: '/search', label: 'Search', end: false },
  { to: '/admin', label: 'Admin · Audit', end: false },
] as const;

export function AppShell(): ReactNode {
  const profile = useSessionStore((state) => state.profile);

  return (
    <div className="flex min-h-dvh flex-col bg-background font-body text-foreground">
      <header className="border-b border-divider">
        <div className="flex items-center border-b border-divider px-[14px] py-2">
          <span className="inline-flex size-[26px] items-center justify-center border border-divider font-heading text-xs">
            NX
          </span>
          <span className="ml-3 text-[11px] uppercase tracking-[0.1em] text-foreground/60">
            Acme &middot; Engineering
          </span>
          <span className="ml-auto text-[11px] text-foreground/60">{profile?.name ?? ''}</span>
        </div>

        <nav aria-label="Sections" className="flex">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                [
                  'relative border-r border-divider px-[22px] pb-[7px] pt-[9px]',
                  'font-heading text-[15px] uppercase tracking-[0.06em]',
                  'hover:bg-accent-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  isActive ? 'text-foreground' : 'text-foreground/70',
                ].join(' ')
              }
            >
              {({ isActive }) => (
                <>
                  {tab.label}
                  {isActive ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-0 bottom-0 h-[2px] bg-accent"
                    />
                  ) : null}
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </header>

      {/* The shell owns the main landmark so every screen has exactly one, and a screen that
          renders panels side by side does not have to nest them inside another. */}
      <main className="flex flex-1">
        <Outlet />
      </main>

      {/* The status strip the design puts along the bottom of every screen. It says what is true
          right now rather than decorating: the tenant this session is pinned to, and the fact that
          isolation is enforced in the database rather than by this application. */}
      <footer className="flex items-center gap-4 border-t border-divider px-[14px] py-1.5 text-[11px] text-foreground/60">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block size-[7px] bg-accent" />
          Single tenant &middot; RLS-isolated
        </span>
        <span className="ml-auto font-mono">{globalThis.location.host}</span>
      </footer>
    </div>
  );
}
