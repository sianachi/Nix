import { Icon, chromeSurface, focusRing } from '@nix/ui';
import { PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';

import type { CurrentPrincipalState } from '../session/use-current-principal';
import { formatShortcut } from '../lib/shortcuts';
import { WorkspaceSwitcher } from '../workspaces/workspace-switcher';
import { shortcutFor } from '../keyboard/shortcut-registry';
import { ProfileMenu } from './profile-menu';

export interface ShellHeaderProps {
  readonly sidebarVisible: boolean;
  readonly sidebarToggleRef: RefObject<HTMLButtonElement | null>;
  readonly workspaceId: string;
  readonly principal: CurrentPrincipalState;
  readonly onToggleSidebar: () => void;
  readonly onOpenSearch: () => void;
}

/**
 * The header as a desktop title bar, when the installed app draws its own.
 *
 * With `display_override: window-controls-overlay` in the manifest, an installed desktop app can
 * hand its title bar to the page: the system's window buttons float over the top-left or top-right
 * corner and the rest of the strip is ours. The header already is that strip, so in that mode it
 * takes the title bar's height, keeps clear of the window buttons on whichever side the platform
 * puts them, and becomes the handle the window is dragged by - everything interactive inside it
 * opting back out, or a click on Search would move the window instead.
 *
 * Only in that display mode: in a browser tab, or an installed window with an ordinary title bar,
 * none of these apply and the header is laid out exactly as before.
 */
// design-token-exempt: the title-bar geometry is the platform's, read from its environment values.
const TITLE_BAR_OVERLAY = [
  '[@media(display-mode:window-controls-overlay)]:[app-region:drag]',
  // Chromium has long read only the prefixed spelling; both, until it is certain it reads either.
  '[@media(display-mode:window-controls-overlay)]:[-webkit-app-region:drag]',
  '[@media(display-mode:window-controls-overlay)]:min-h-[env(titlebar-area-height,0px)]',
  '[@media(display-mode:window-controls-overlay)]:py-0!',
  '[@media(display-mode:window-controls-overlay)]:pl-[max(1rem,env(titlebar-area-x,0px))]!', // design-token-exempt: the platform's title-bar inset, floored at the header's own sm:px-4
  '[@media(display-mode:window-controls-overlay)]:pr-[max(1rem,calc(100vw-env(titlebar-area-x,0px)-env(titlebar-area-width,100vw)))]!', // design-token-exempt: the window buttons' width on the right, floored at the header's own sm:px-4
  '[@media(display-mode:window-controls-overlay)]:[&_:is(a,button,input,select,[role=button],[role=combobox],[tabindex])]:[app-region:no-drag]',
  '[@media(display-mode:window-controls-overlay)]:[&_:is(a,button,input,select,[role=button],[role=combobox],[tabindex])]:[-webkit-app-region:no-drag]',
].join(' ');

const SEARCH_KEYS = shortcutFor('search').keys;

/** The persistent shell controls that remain visible while the workspace tree changes shape. */
export function ShellHeader({
  sidebarVisible,
  sidebarToggleRef,
  workspaceId,
  principal,
  onToggleSidebar,
  onOpenSearch,
}: ShellHeaderProps): ReactNode {
  return (
    <header
      className={`flex min-w-0 shrink-0 items-center gap-1.5 px-2 py-2 sm:gap-3 sm:px-4 ${chromeSurface} ${TITLE_BAR_OVERLAY}`}
    >
      {/* Next to the tree it opens and closes, rather than inside it - a control that vanishes
          with the thing it controls cannot bring it back. */}
      <button
        ref={sidebarToggleRef}
        type="button"
        aria-label={sidebarVisible ? 'Hide the workspace tree' : 'Show the workspace tree'}
        aria-expanded={sidebarVisible}
        onClick={onToggleSidebar}
        className={`flex size-(--control-sm) items-center justify-center rounded-md text-muted max-sm:min-h-11 max-sm:min-w-11 hover:bg-foreground/7 hover:text-foreground ${focusRing}`}
      >
        <Icon icon={sidebarVisible ? PanelLeftClose : PanelLeftOpen} size="sm" />
      </button>

      <Link
        to={`/w/${workspaceId}`}
        aria-label="Nix home"
        className={`hidden size-(--control-sm) items-center justify-center rounded-md border border-divider font-heading text-xs sm:inline-flex ${focusRing}`}
      >
        NX
      </Link>

      <WorkspaceSwitcher />

      <button
        type="button"
        onClick={onOpenSearch}
        aria-label="Search"
        className={`ml-auto flex shrink-0 max-sm:min-h-11 max-sm:min-w-11 items-center gap-2 rounded-md bg-surface px-2 py-1.5 text-xs text-muted hover:bg-foreground/7 sm:px-3 ${focusRing}`}
      >
        <Icon icon={Search} size="sm" />
        <span className="hidden sm:inline">Search</span>
        {/* The shortcut is shown rather than hidden in a tooltip: a shortcut nobody can discover
            is a shortcut nobody uses. */}
        <kbd className="hidden font-mono text-2xs text-muted md:inline">
          {SEARCH_KEYS.map((keys) => formatShortcut(keys)).join(' ')}
        </kbd>
      </button>

      <ProfileMenu principal={principal} />
    </header>
  );
}
