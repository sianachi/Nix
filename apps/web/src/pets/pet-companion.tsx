import { items, type PetConnection, type PetProfile, type PetSettings } from '@nix/api-client';
import {
  Button,
  Checkbox,
  Icon,
  Menu,
  Segmented,
  Select,
  Text,
  focusRing,
  type MenuEntry,
} from '@nix/ui';
import {
  ArrowLeft,
  ArrowUp,
  Mic,
  MoreHorizontal,
  Square,
  TextQuote,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useApiClient } from '../api/api-client-provider';
import { useWorkspace } from '../workspaces/workspace-context';
import { useNarrowViewport } from '../layout/viewport';
import { useMobileKeyboard } from '../layout/use-mobile-keyboard';
import { useBackDismiss } from '../layout/use-back-dismiss';
import { PetAvatar, type PetAnimationState } from './pet-avatar';
import { usePetSettings } from './use-pet-settings';
import { usePetVoice } from './use-pet-voice';
import { usePetRuntime, type UsePetRuntimeResult } from './use-pet-runtime';
import {
  readConversationModel,
  readDevicePreference,
  readPetPosition,
  readReadWithoutAsking,
  readWorkspaceAccess,
  writePetPosition,
  writeConversationModel,
  writeReadWithoutAsking,
  writeWorkspaceAccess,
  type PetConversationMode,
} from './device-preferences';
import { PetWorkTools } from './pet-work-tools';
import { PetConnectionPanel } from './pet-connection-panel';
import { PetHistory, exportPetMessages } from './pet-history';
import { PetChatViewport } from './pet-chat-viewport';
import { PetMessageText } from './pet-message-text';

/** How much of the viewport's bottom edge the mobile navigation currently occupies, read from
 * the shell's own measurement (`app-shell.tsx` publishes `--mobile-nav-height`) rather than
 * guessed at here. Zero whenever the nav is not rendered - a wide screen, or the software
 * keyboard covering it - because the shell removes the property then. Used to keep a dragged or
 * clamped launcher position clear of the nav, the same clearance `narrowOffset` below gives the
 * launcher's own default position. */
function mobileNavClearance(): number {
  const parsed = Number.parseFloat(
    document.documentElement.style.getPropertyValue('--mobile-nav-height'),
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The composer's textarea grows with its content between one and six rows, rather than
 * scrolling internally past a fixed height. Counting hard line breaks is a close enough
 * approximation of wrapped-line count for a message box this size, without measuring layout. */
const CONVERSATION_MODE_OPTIONS: readonly { value: PetConversationMode; label: string }[] = [
  { value: 'chat', label: 'Chat' },
  { value: 'consult', label: 'Design' },
];

function composerRows(text: string): number {
  const lines = text.split('\n').length;
  return Math.min(6, Math.max(1, lines));
}

/** The header's status line, in plain words rather than the raw animation state - never
 * "listening" or "hover", only what the person actually needs to know right now. `needsDecision`
 * - whether *this* turn's tools were reported back by `PetWorkTools` as actually waiting on the
 * owner (11/12/S1) - is the only source for "Waiting for your approval": an auto-run read that
 * happens to still be `pending` must never say so. */
function statusText({
  runtimeLoaded,
  connected,
  errored,
  hasDraft,
  needsDecision,
  running,
}: {
  readonly runtimeLoaded: boolean;
  readonly connected: boolean;
  readonly errored: boolean;
  readonly hasDraft: boolean;
  readonly needsDecision: boolean;
  readonly running: boolean;
}): string {
  if (!runtimeLoaded) return 'Connecting';
  if (!connected) return 'Not connected';
  if (errored) return 'Something went wrong';
  if (hasDraft) return 'Writing';
  if (needsDecision) return 'Waiting for your approval';
  if (running) return 'Thinking';
  return 'Ready';
}

/** Where the latest turn's tool rows belong among `messages`: right after the last user
 * message and any commentary that followed it (id contains `:commentary:`), and before that
 * turn's final answer (id `${lastUserMessageId}:assistant`) or its still-streaming draft (id
 * contains `:draft:`) - or at the very end when neither has arrived yet. The worker resets
 * `tools` on every send (`manager.go` `c.Tools = []ToolCall{}`), so every tool call in the
 * runtime belongs to this one turn; earlier turns render with no tool rows at all. */
function toolInsertIndex(
  messages: readonly NonNullable<PetConnection['messages']>[number][],
): number {
  let lastUserIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === 'user') lastUserIndex = index;
  }
  if (lastUserIndex === -1) return messages.length;
  let index = lastUserIndex + 1;
  while (index < messages.length && messages[index]?.id.includes(':commentary:')) index += 1;
  return index;
}

export function PetCompanion(): ReactElement | null {
  const { workspaceId } = useWorkspace();
  const { saved } = usePetSettings();
  const pet = saved?.settings.profiles.find((profile) => profile.id === saved.settings.activePetId);
  if (!saved?.settings.enabled || !pet) return null;
  return (
    <Companion
      key={`${workspaceId}:${pet.id}`}
      workspaceId={workspaceId}
      pet={pet}
      settings={saved.settings}
    />
  );
}

function Companion({
  workspaceId,
  pet,
  settings,
}: {
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
}) {
  const [search] = useSearchParams();
  const designEntry = search.get('pet') === 'design';
  const [mode, setMode] = useState<PetConversationMode>(designEntry ? 'consult' : 'chat');
  const [open, setOpen] = useState(false);
  const client = useApiClient();
  const runtimeApi = usePetRuntime(workspaceId, pet.id, mode, open);
  // The ids of the pending tools `PetWorkTools` itself reports as actually waiting on the owner
  // - never any `pending` tool, which would also badge an auto-run read - see must-fix 1. Only
  // one `PetWorkTools` instance is ever mounted at a time (the hidden one below while the panel
  // is closed, or the one inside `Conversation` while it is open), so a single lifted setter
  // here is always hearing from whichever one is currently live.
  const [needsDecisionIds, setNeedsDecisionIds] = useState<readonly string[]>([]);
  const toolPending = needsDecisionIds.length > 0;
  const [unseenReply, setUnseenReply] = useState(false);
  const previousState = useRef(runtimeApi.runtime?.state);
  // A reply that finishes while the panel is closed sets the launcher badge; opening the panel
  // clears it. The `queueMicrotask` wrapper (the same one `designEntry` below uses) is what
  // keeps this a subscription-style callback reacting to the runtime's own change, rather than
  // a derived value computed synchronously in the effect body. Must-fix 2: only a real
  // thinking -> success transition badges the launcher - the very first state this hook ever
  // observes (an already-finished conversation loading for the first time) is a baseline, not a
  // reply that "just" finished, so it must never itself set the badge.
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const state = runtimeApi.runtime?.state;
      if (open) setUnseenReply(false);
      else if (state === 'success' && previousState.current === 'thinking') setUnseenReply(true);
      previousState.current = state;
    });
    return () => {
      active = false;
    };
  }, [open, runtimeApi.runtime?.state]);
  const [hover, setHover] = useState(false);
  const [openAnchor, setOpenAnchor] = useState<CSSProperties | null>(null);
  const launcher = useRef<HTMLButtonElement | null>(null);
  const [placement, setPlacement] = useState(() => readDevicePreference('placement'));
  const [position, setPosition] = useState(() => readPetPosition());
  const drag = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const returnFocus = useRef(false);
  const narrow = useNarrowViewport();
  useBackDismiss(open && narrow, () => {
    setOpen(false);
    setOpenAnchor(null);
    returnFocus.current = true;
  });
  const keyboardVisible = useMobileKeyboard(narrow);
  const launcherHidden = open || (narrow && keyboardVisible);
  useEffect(() => {
    if (!designEntry) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setMode('consult');
      setOpen(true);
    });
    return () => {
      active = false;
    };
  }, [designEntry]);
  // Close (or the back gesture) may fire while the keyboard still occludes the page, which
  // keeps the launcher `hidden`; a hidden button cannot take focus, so waiting for
  // `launcherHidden` to clear - rather than focusing right on close - is what makes focus land
  // on it once it is actually visible again, on a phone or a desktop alike.
  useEffect(() => {
    if (returnFocus.current && !launcherHidden) {
      returnFocus.current = false;
      launcher.current?.focus();
    }
  }, [launcherHidden]);
  useEffect(() => {
    const changed = () => {
      setPlacement(readDevicePreference('placement'));
      setPosition(readPetPosition());
    };
    window.addEventListener('nix-pet-device-changed', changed);
    return () => {
      window.removeEventListener('nix-pet-device-changed', changed);
    };
  }, []);
  // A saved position can sit off-screen, or over the bottom navigation, at a width or clearance
  // different from the one it was saved at - a desktop position visited on a phone, a phone
  // rotated to landscape crossing back past the phone breakpoint, a tablet, or a placement
  // changed from the settings page in this same tab. This keeps what is *rendered* inside the
  // viewport and clear of the nav on load, resize, orientation change, a placement change, and a
  // change in the nav's own measured height (a PWA banner appearing above it); it never writes
  // back, so the saved position itself is untouched and a width that fits it again renders it
  // exactly as saved. Only a user drag (`onPointerMove` below) calls `writePetPosition`.
  useEffect(() => {
    const recompute = () => {
      const saved = readPetPosition();
      if (!saved) return;
      const rect = launcher.current?.getBoundingClientRect();
      // A `hidden` launcher (the keyboard is up) measures 0x0; clamping to that would pin the
      // button flush with the far edge instead of leaving it where it actually is. Skipping
      // then is safe: `keyboardVisible` is also a dependency below, so this re-runs, with a real
      // rect, the moment the launcher is visible again.
      if (!rect || rect.width === 0 || rect.height === 0) return;
      const next = {
        x: Math.min(Math.max(8, saved.x), Math.max(8, window.innerWidth - rect.width - 8)),
        y: Math.min(
          Math.max(8, saved.y),
          Math.max(8, window.innerHeight - rect.height - 8 - mobileNavClearance()),
        ),
      };
      setPosition((current) => {
        const unchanged = current !== null && current.x === next.x && current.y === next.y;
        return unchanged ? current : next;
      });
    };
    recompute();
    window.addEventListener('resize', recompute);
    window.addEventListener('orientationchange', recompute);
    // A placement change from the settings page (the effect above, listening for the same event)
    // sets the raw saved value first; registered after it, this listener always runs second for
    // the same dispatch and reclamps whatever it just set.
    window.addEventListener('nix-pet-device-changed', recompute);
    // The shell's own measurement of the nav's height (`app-shell.tsx`) can change without the
    // window resizing at all - a PWA install or update banner appearing above the nav grows it -
    // so the shell announces every change to it rather than leaving this to notice only on the
    // next resize.
    window.addEventListener('nix-mobile-nav-resized', recompute);
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('orientationchange', recompute);
      window.removeEventListener('nix-pet-device-changed', recompute);
      window.removeEventListener('nix-mobile-nav-resized', recompute);
    };
  }, [keyboardVisible]);
  // No token names the mobile navigation's rendered height (mobile-navigation.tsx has no fixed
  // height of its own, and includes the PWA banner above it when shown); 3.5rem plus the safe-area
  // inset is the fallback so a phone launcher never sits under it before the shell has measured
  // one, or once the nav is not rendered at all. The measured value already includes the inset
  // (`mobile-navigation.tsx` pads itself with it), so only the fallback adds it. Cleared at `lg:`
  // (1024px, `WIDE_ENOUGH_FOR_A_FIXED_SIDEBAR` in `layout/regions.ts`) rather than `sm:`: the
  // bottom navigation this offset clears renders across the whole drawer-nav range
  // (`useDrawerNavigation`, below 1024px), a tablet included, not only below the phone breakpoint
  // (`useNarrowViewport`, 640px) that `narrow` itself tracks.
  const narrowOffset = 'bottom-[var(--mobile-nav-height,calc(3.5rem+env(safe-area-inset-bottom)))]'; // design-token-exempt: no token for the mobile nav's rendered height.
  return (
    <aside
      aria-label={`${pet.name} companion`}
      className={`fixed z-40 flex max-w-full flex-col gap-2 p-2 ${position ? '' : `${narrowOffset} lg:bottom-4 ${placement === 'left' ? 'left-0 items-start sm:left-4' : 'right-0 items-end sm:right-4'}`}`}
      style={
        position
          ? open && openAnchor
            ? openAnchor
            : { left: position.x, top: position.y }
          : undefined
      }
    >
      {open ? (
        // Must-fix 17: kept mounted across a mode switch (the key no longer includes `mode`) so
        // the draft and shared selection survive it; `Conversation` itself keeps those two
        // per-mode rather than as a single value that would otherwise leak across modes.
        <Conversation
          key={`${workspaceId}:${pet.id}`}
          workspaceId={workspaceId}
          pet={pet}
          settings={settings}
          mode={mode}
          onModeChange={setMode}
          narrow={narrow}
          runtimeApi={runtimeApi}
          onNeedsDecisionChange={setNeedsDecisionIds}
          onClose={() => {
            setOpen(false);
            setOpenAnchor(null);
            returnFocus.current = true;
          }}
        />
      ) : runtimeApi.runtime ? (
        // Auto-run reads (READ_ONLY_OPERATIONS / validate_blueprint under readWithoutAsking)
        // must still run while the panel is closed, so a closed panel never stalls a turn on a
        // read - see `ReadActivityRow`'s own auto-run effect. `hidden` keeps this out of both
        // the visual layout and the accessibility tree while the panel is closed.
        <div className="hidden">
          <PetWorkTools
            client={client}
            runtime={runtimeApi.runtime}
            workspaceId={workspaceId}
            petId={pet.id}
            petName={pet.name}
            mode={mode}
            onChange={runtimeApi.setRuntime}
            onNeedsDecisionChange={setNeedsDecisionIds}
          />
        </div>
      ) : null}
      <Button
        ref={launcher}
        variant="ghost"
        className={`relative h-auto touch-none p-1 ${launcherHidden ? 'hidden' : ''}`}
        aria-expanded={open}
        aria-label={`${open ? `Close ${pet.name}` : `Talk with ${pet.name}`}${
          !open && toolPending ? ' (needs approval)' : !open && unseenReply ? ' (new reply)' : ''
        }`}
        onMouseEnter={() => {
          setHover(true);
        }}
        onMouseLeave={() => {
          setHover(false);
        }}
        onClick={(event) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          const nextOpen = !open;
          if (nextOpen && position) {
            const rect = event.currentTarget.getBoundingClientRect();
            setOpenAnchor(
              rect.top > window.innerHeight / 2
                ? {
                    bottom: Math.max(8, window.innerHeight - rect.bottom),
                    ...(rect.left > window.innerWidth / 2
                      ? { right: Math.max(8, window.innerWidth - rect.right) }
                      : { left: Math.max(8, rect.left) }),
                  }
                : null,
            );
          } else {
            setOpenAnchor(null);
          }
          setOpen(nextOpen);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          // A drag that ends past the tap slop, on touch, dispatches no `click` at all: the flag
          // `onClick` would otherwise clear stays set, and the very next real tap is swallowed
          // silently. Starting every new pointer-down clean is what keeps a stale flag from a
          // prior drag from ever eating a later tap.
          suppressClick.current = false;
          const rect = event.currentTarget.getBoundingClientRect();
          drag.current = {
            pointerId: event.pointerId,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
          };
          if (typeof event.currentTarget.setPointerCapture === 'function')
            event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const active = drag.current;
          if (active?.pointerId !== event.pointerId) return;
          // Cumulative distance from where the pointer went down, rather than the per-event
          // `movementX`/`movementY` delta: some engines never populate a non-zero delta for a
          // touch pointer, which would otherwise make a drag never register as one at all.
          const moved =
            active.moved ||
            Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > 2;
          active.moved = moved;
          if (!moved) return;
          suppressClick.current = true;
          const rect = event.currentTarget.getBoundingClientRect();
          const x = Math.min(
            Math.max(8, event.clientX - active.offsetX),
            window.innerWidth - rect.width - 8,
          );
          const y = Math.min(
            Math.max(8, event.clientY - active.offsetY),
            Math.max(8, window.innerHeight - rect.height - 8 - mobileNavClearance()),
          );
          const next = { x, y };
          setPosition(next);
          writePetPosition(next);
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId === event.pointerId) drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        title="Drag to move companion"
      >
        <PetAvatar
          appearance={pet.appearance}
          state={hover ? 'hover' : 'idle'}
          motion={settings.motion}
          label={pet.name}
          size={narrow ? 'compact' : 'regular'}
        />
        {!open && (toolPending || unseenReply) ? (
          <span
            aria-hidden="true"
            className="absolute right-0 top-0 size-2.5 rounded-full bg-accent-fill"
          />
        ) : null}
      </Button>
    </aside>
  );
}

type ConversationPanel = 'chat' | 'settings' | 'history';

interface SharedContext {
  /** The item the message's context is scoped to - always sent as `itemId`, never as free text
   * the model could be tricked into treating as an instruction. */
  readonly itemId: string;
  /** Explicit selected text (`shareSelection`) - empty for a whole-page share, where the worker
   * already resolves the item's own content from `itemId` (`currentItemId` in its prompt). */
  readonly sharedText: string;
  /** What the removable chip shows, e.g. `"This page: Weekly plan"` or a selection's own text. */
  readonly label: string;
}

function Conversation({
  workspaceId,
  pet,
  settings,
  mode,
  onModeChange,
  narrow,
  runtimeApi,
  onNeedsDecisionChange,
  onClose,
}: {
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
  readonly mode: PetConversationMode;
  readonly onModeChange: (mode: PetConversationMode) => void;
  readonly narrow: boolean;
  readonly runtimeApi: UsePetRuntimeResult;
  readonly onNeedsDecisionChange: (toolIds: readonly string[]) => void;
  readonly onClose: () => void;
}) {
  const client = useApiClient();
  const location = useLocation();
  const [search] = useSearchParams();
  const currentItem = search.get('item');
  const {
    runtime,
    models,
    busy,
    error,
    errorKind,
    setRuntime,
    regenerateRequestId,
    send,
    interrupt,
    reset,
    reload,
    retryWatch,
  } = runtimeApi;
  const [panel, setPanel] = useState<ConversationPanel>('chat');
  // Must-fix 17: a draft and a shared context per mode, not one value the other mode's switch
  // would otherwise clobber - `Conversation` stays mounted across a mode change (see its `key`
  // in `Companion` above), so without this a half-typed Chat draft would vanish the moment
  // someone opened Design and came back.
  const [draftByMode, setDraftByMode] = useState<Record<PetConversationMode, string>>({
    chat: '',
    consult: '',
  });
  const [sharedByMode, setSharedByMode] = useState<
    Record<PetConversationMode, SharedContext | null>
  >({ chat: null, consult: null });
  const draft = draftByMode[mode];
  const shared = sharedByMode[mode];
  function setDraft(next: string) {
    setDraftByMode((old) => ({ ...old, [mode]: next }));
  }
  function setShared(next: SharedContext | null) {
    setSharedByMode((old) => ({ ...old, [mode]: next }));
  }
  const [model, setModel] = useState(() => readConversationModel(workspaceId, pet.id, mode));
  // The model choice is still per mode, but the conversation no longer remounts to pick up a new
  // one - adjusted during render, the same way `PetSettingsEditor` picks up a changed `initial`,
  // rather than through an effect (which would set state synchronously in its own body, the
  // cascading render `react-hooks/set-state-in-effect` exists to stop).
  const [previousModelMode, setPreviousModelMode] = useState(mode);
  if (previousModelMode !== mode) {
    setPreviousModelMode(mode);
    setModel(readConversationModel(workspaceId, pet.id, mode));
  }
  const [workspaceAccess, setWorkspaceAccess] = useState(() =>
    readWorkspaceAccess(workspaceId, pet.id),
  );
  const [readWithoutAsking, setReadWithoutAsking] = useState(() => readReadWithoutAsking());
  const [needsDecisionIds, setNeedsDecisionIds] = useState<readonly string[]>([]);
  const [currentItemTitle, setCurrentItemTitle] = useState<string | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  // Must-fix 7: `Text` deliberately takes no `ref`/`tabIndex` (its own contract refuses an open
  // prop spread), so the focus target on open is a plain wrapper around the visible `<h3>` -
  // still announced as a level-3 heading, just not itself the tab stop.
  const panelHeading = useRef<HTMLDivElement | null>(null);
  const menuTrigger = useRef<{ current: HTMLButtonElement | null } | null>(null);
  const narrationPending = useRef(false);
  const voice = usePetVoice((text) => {
    setDraft(`${draft}${draft ? ' ' : ''}${text}`.slice(0, 8000));
    regenerateRequestId();
  });
  const messages = runtime?.messages ?? [];
  const running = runtime?.state === 'thinking';
  const approvalPending = needsDecisionIds.length > 0;
  const hasDraft = messages.some((message) => message.id.includes(':draft:'));
  const animation: PetAnimationState = voice.listening
    ? 'listening'
    : voice.speaking
      ? 'speaking'
      : approvalPending
        ? 'awaiting-approval'
        : running || busy
          ? 'thinking'
          : error || runtime?.state === 'error'
            ? 'error'
            : runtime?.state === 'success'
              ? 'success'
              : 'idle';
  const errored = Boolean(error) || runtime?.state === 'error';
  const connected = runtime?.status === 'connected';

  // Stable identity: `PetWorkTools` re-fires its own reporting effect whenever the callback it
  // was given changes identity, so a plain function redefined on every render here would make
  // that effect (and the render it triggers) loop forever, given the needs-decision array it
  // reports is itself a fresh array each time even when unchanged in content.
  const reportNeedsDecision = useCallback(
    (toolIds: readonly string[]) => {
      setNeedsDecisionIds(toolIds);
      onNeedsDecisionChange(toolIds);
    },
    [onNeedsDecisionChange],
  );

  function goBackFromPanel() {
    setPanel('chat');
    menuTrigger.current?.current?.focus();
  }

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !dialog.current?.contains(document.activeElement)) return;
      event.stopPropagation();
      // Must-fix 7: Escape inside a sub-panel backs out of it, rather than closing the whole
      // conversation the way it does from the chat panel itself.
      if (panel !== 'chat') goBackFromPanel();
      else onClose();
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
    };
  }, [onClose, panel]);

  // Must-fix 7: the sub-panel's own heading takes focus as soon as it opens, so a screen reader
  // announces where focus landed rather than leaving it on whatever menu item was just chosen.
  useEffect(() => {
    if (panel !== 'chat') panelHeading.current?.focus();
  }, [panel]);

  // Must-fix 6: on a narrow screen the conversation has no room to share with the page behind
  // it, so a link followed from inside it (the menu's "Pet settings", a receipt's "Inspect
  // target item", a reply's own item link) must close it - otherwise the person navigates
  // somewhere new and never sees where they landed.
  const initialLocationKey = useRef(`${location.pathname}?${search.get('item') ?? ''}`);
  useEffect(() => {
    if (!narrow) return;
    const key = `${location.pathname}?${search.get('item') ?? ''}`;
    if (key === initialLocationKey.current) return;
    initialLocationKey.current = key;
    onClose();
  }, [narrow, location.pathname, search, onClose]);

  // Must-fix 5: resolves the open item's title for the "This page: {title}" chip. The worker
  // resolves its own copy of the title from `itemId` server-side (`currentItemTitle` in its
  // prompt) - this is display-only, never sent as text itself.
  useEffect(() => {
    const controller = new AbortController();
    // Deferred a microtask, the same way `use-bookmarks.ts`'s loader defers its own first read:
    // setting state synchronously in an effect body is the cascading render
    // `react-hooks/set-state-in-effect` exists to stop.
    queueMicrotask(() => {
      if (!controller.signal.aborted) setCurrentItemTitle(null);
    });
    if (!currentItem) return;
    void client
      .query(items.itemById(currentItem), { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setCurrentItemTitle(value.title);
      })
      .catch(() => {
        /* The chip still offers a plain fallback below when the title cannot be resolved. */
      });
    return () => {
      controller.abort();
    };
  }, [client, currentItem]);

  // Must-fix 24: "Share selected text" is only ever meaningfully enabled while there really is a
  // selection on the page.
  useEffect(() => {
    const update = () => {
      setHasSelection(Boolean(window.getSelection()?.toString().trim()));
    };
    update();
    document.addEventListener('selectionchange', update);
    return () => {
      document.removeEventListener('selectionchange', update);
    };
  }, []);

  useEffect(() => {
    if (!narrow) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [narrow]);

  // A full-screen phone dialog has no page underneath it to fall back on, so Tab is kept from
  // ever walking out of it and onto the shell painted below.
  useEffect(() => {
    if (!narrow) return;
    const node = dialog.current;
    if (!node) return;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    node.addEventListener('keydown', trap);
    return () => {
      node.removeEventListener('keydown', trap);
    };
  }, [narrow]);

  // `100dvh` does not always shrink for the software keyboard (it depends on the browser's
  // virtual-keyboard resize mode), so the phone dialog's own height is measured from
  // `visualViewport` instead - the same approach `mobile-note-toolbar.tsx` uses - and written
  // onto the element so the composer at its bottom edge stays above the keyboard rather than
  // being covered by it.
  useEffect(() => {
    if (!narrow) return;
    const node = dialog.current;
    const viewport = window.visualViewport;
    if (!node) return;
    let frame = 0;
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;
        node.style.setProperty('--phone-dialog-height', `${String(height)}px`);
      });
    };
    measure();
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', measure);
      viewport?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [narrow]);

  useEffect(() => {
    // On a phone the dialog itself takes focus first (its name is announced, and Tab starts
    // from a known place); on a wide screen the composer keeps taking it directly, as before.
    if (narrow) dialog.current?.focus();
    else input.current?.focus();
  }, [narrow]);

  useEffect(() => {
    const changed = () => {
      setReadWithoutAsking(readReadWithoutAsking());
    };
    window.addEventListener('nix-pet-device-changed', changed);
    return () => {
      window.removeEventListener('nix-pet-device-changed', changed);
    };
  }, []);

  useEffect(() => {
    if (!narrationPending.current || runtime?.state !== 'success') return;
    narrationPending.current = false;
    const last = runtime.messages?.at(-1);
    // Narration speaks a finished reply only, never a still-streaming draft (id contains
    // `:draft:`) - `runtime.state === 'success'` above should already mean the turn is done,
    // but this is the belt to that suspender's braces.
    if (settings.narration && last?.role === 'assistant' && !last.id.includes(':draft:'))
      voice.speak(last.text);
  }, [runtime, settings.narration, voice]);

  function shareSelection() {
    const text = window.getSelection()?.toString().trim() ?? '';
    if (!currentItem || !text) return;
    const trimmed = text.slice(0, 16000);
    setShared({ itemId: currentItem, sharedText: trimmed, label: trimmed.slice(0, 120) });
  }

  /** Must-fix 5: "Summarize this page" attaches the open item as a removable chip, sent as
   * `itemId` with no `sharedText` - the worker already resolves the item's own content from
   * `currentItemId` in its prompt, so nothing here re-sends the page's text itself. */
  function attachPageContext() {
    if (!currentItem) return;
    setShared({
      itemId: currentItem,
      sharedText: '',
      label: `This page: ${currentItemTitle ?? 'Untitled'}`,
    });
  }

  async function submit() {
    if (!draft.trim() || busy || runtime?.status !== 'connected') return;
    const ok = await send({
      text: draft,
      model,
      workspaceAccess,
      ...(shared ? { itemId: shared.itemId, sharedText: shared.sharedText } : {}),
    });
    if (ok) {
      narrationPending.current = true;
      setDraft('');
      setShared(null);
    }
  }

  /** Must-fix 4: a failed turn (the worker reports `state: 'error'`, not a client-side request
   * failure) offers its own "Try again" that resends the *last user message*, as a new request -
   * unlike a failed `send`, which retries the exact same one. */
  function retryLastTurn() {
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    if (!lastUser) return;
    regenerateRequestId();
    void send({
      text: lastUser.text,
      model,
      workspaceAccess,
      ...(shared ? { itemId: shared.itemId, sharedText: shared.sharedText } : {}),
    });
  }

  /** Must-fix 4: the label a hook-level `error` offers, keyed by `errorKind` - `send` and
   * `command` both resubmit ("Try again"), `load` wakes the watch loop instead ("Retry now").
   * Voice errors carry no hook `error` at all, so they never reach this - no button for them. */
  function retryLabel(): string | null {
    if (errorKind === 'send' || errorKind === 'command') return 'Try again';
    if (errorKind === 'load') return 'Retry now';
    return null;
  }
  /** The action behind that label - `send` resubmits the same request (the request id stays
   * fixed since a failed `send` never regenerates it), `load` wakes the watch loop, and
   * `command` retries whatever one-off request (interrupt, reset, an explicit reload) failed. */
  function retryError() {
    if (errorKind === 'send') void submit();
    else if (errorKind === 'load') retryWatch();
    else if (errorKind === 'command') void reload();
  }
  const loadErrorMessage = `Lost connection to ${pet.name}. Retrying…`;

  function onComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    // Must-fix 18: an IME composition's confirming Enter arrives as `keyCode === 229` on some
    // browsers without `isComposing` also being set - both are checked so it is never mistaken
    // for a real submit.
    // `keyCode` is deprecated but is the only signal some browsers give for an IME's confirming
    // Enter once `isComposing` has already gone false.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.shiftKey || touchLikeComposer) return;
    event.preventDefault();
    void submit();
  }

  const menuItems: MenuEntry[] = [
    {
      label: 'New conversation',
      disabled: busy || running,
      onSelect: () => {
        void reset();
      },
    },
    {
      label: 'Past conversations',
      onSelect: () => {
        setPanel('history');
      },
    },
    {
      label: 'Export conversation',
      disabled: !messages.length,
      onSelect: () => {
        exportPetMessages(messages, pet.name);
      },
    },
    {
      label: 'Reload conversation',
      onSelect: () => {
        void reload();
      },
    },
    { kind: 'separator' },
    {
      label: 'Chat settings',
      onSelect: () => {
        setPanel('settings');
      },
    },
    {
      kind: 'link',
      label: 'Pet settings',
      href: `/w/${workspaceId}/settings`,
    },
  ];

  // Must-fix 5: "Add a status field to this list" only makes sense with an item open; "Summarize
  // this page" the same.
  const suggestions =
    mode === 'consult'
      ? ['Plan my reading', 'Track a job hunt', 'Weekly meal plan']
      : currentItem
        ? ['Summarize this page', 'Find my notes about...', 'Add a status field to this list']
        : ['Find my notes about...'];

  // Must-fix 18: Enter inserts a newline (the Send button is what sends) once the screen is
  // narrow or the pointer itself is coarse - a touch keyboard's Enter key is not a reliable
  // "submit" gesture the way a physical keyboard's is.
  const touchLikeComposer =
    narrow || (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches);

  const dialogClass = narrow
    ? 'fixed inset-0 z-40 flex h-[var(--phone-dialog-height,100dvh)] w-full flex-col overflow-hidden bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground outline-none'
    : 'flex h-[calc(100dvh-var(--spacing)*36)] max-h-192 w-128 max-w-full flex-col overflow-hidden rounded-lg border border-divider bg-background text-foreground shadow-lg outline-none';

  const needsWorkspaceAccessForChip = Boolean(shared) && !workspaceAccess;

  return (
    <div
      ref={dialog}
      role="dialog"
      tabIndex={-1}
      aria-modal={narrow}
      aria-label={`Conversation with ${pet.name}`}
      className={dialogClass}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-divider px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <div
            aria-hidden="true"
            className={`shrink-0 overflow-visible ${narrow ? 'size-10' : 'size-14'}`}
          >
            <div className="origin-top-left scale-50">
              <PetAvatar
                appearance={pet.appearance}
                motion={settings.motion}
                state={animation}
                label={`${pet.name}: ${animation}`}
              />
            </div>
          </div>
          <div className={narrow ? 'flex min-w-0 flex-col' : 'flex min-w-0 items-center gap-3'}>
            <Text variant="h3" as="h2" truncate>
              {pet.name}
            </Text>
            <Text role="status" variant="note" tone="muted" truncate>
              {statusText({
                runtimeLoaded: Boolean(runtime),
                connected,
                errored,
                hasDraft,
                needsDecision: approvalPending,
                running,
              })}
            </Text>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Segmented
            label="Conversation mode"
            options={CONVERSATION_MODE_OPTIONS}
            value={mode}
            onChange={onModeChange}
          />
          <Menu label="Conversation actions" items={menuItems} renderLink={renderMenuLink}>
            {(trigger) => {
              menuTrigger.current = trigger.ref;
              return (
                <Button {...trigger} variant="icon" aria-label="More conversation actions">
                  <Icon icon={MoreHorizontal} size="sm" />
                </Button>
              );
            }}
          </Menu>
          <Button variant="icon" aria-label="Close" onClick={onClose}>
            <Icon icon={X} size="sm" />
          </Button>
        </div>
      </div>
      {panel === 'settings' ? (
        <PetSettingsPanel
          pet={pet}
          workspaceId={workspaceId}
          mode={mode}
          model={model}
          models={models}
          running={running || busy}
          runtime={runtime}
          readWithoutAsking={readWithoutAsking}
          headingRef={panelHeading}
          onModelChange={(next) => {
            setModel(next);
            writeConversationModel(workspaceId, pet.id, mode, next);
          }}
          onReadWithoutAskingChange={(next) => {
            setReadWithoutAsking(next);
            writeReadWithoutAsking(next);
          }}
          onBack={goBackFromPanel}
        />
      ) : panel === 'history' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
          <div className="flex items-center gap-2 self-start">
            <Button variant="ghost" onClick={goBackFromPanel}>
              <Icon icon={ArrowLeft} size="sm" />
              Back
            </Button>
            <div ref={panelHeading} tabIndex={-1} className="outline-none">
              <Text as="h3" variant="h3">
                Past conversations
              </Text>
            </div>
          </div>
          <PetHistory
            workspaceId={workspaceId}
            petId={pet.id}
            name={pet.name}
            client={client}
            mode={mode}
          />
        </div>
      ) : !runtime ? (
        // Must-fix 11/12: while nothing has ever loaded yet, the body says so plainly instead of
        // showing the empty-state suggestions as if the conversation were simply quiet - and once
        // a load error shows up here, it replaces the "Loading" text rather than sitting beside it.
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
          {errorKind === 'load' && error ? (
            <>
              <Text role="alert">{loadErrorMessage}</Text>
              <Button variant="ghost" onClick={retryWatch}>
                Retry now
              </Button>
            </>
          ) : (
            <Text variant="note" tone="muted">
              Loading conversation…
            </Text>
          )}
        </div>
      ) : !connected ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <PetConnectionPanel />
        </div>
      ) : (
        <>
          <PetChatViewport
            latestKey={`${messages.at(-1)?.id ?? ''}:${runtime.tools?.at(-1)?.id ?? ''}:${running ? 'thinking' : 'idle'}`}
          >
            {runtime.state === 'error' ? (
              <div className="flex items-center justify-between gap-2">
                <Text role="alert">
                  {runtime.reason || 'The response did not finish. Try again.'}
                </Text>
                <Button variant="ghost" onClick={retryLastTurn}>
                  Try again
                </Button>
              </div>
            ) : null}
            {messages.length === 0 ? (
              <>
                <PetEmptyState
                  mode={mode}
                  petName={pet.name}
                  workspaceAccess={workspaceAccess}
                  suggestions={suggestions}
                  onPick={(suggestion) => {
                    setDraft(suggestion);
                    if (suggestion === 'Summarize this page') attachPageContext();
                    regenerateRequestId();
                    input.current?.focus();
                  }}
                />
                <PetWorkTools
                  client={client}
                  runtime={runtime}
                  workspaceId={workspaceId}
                  petId={pet.id}
                  petName={pet.name}
                  mode={mode}
                  onChange={setRuntime}
                  onNeedsDecisionChange={reportNeedsDecision}
                />
              </>
            ) : (
              (() => {
                const splitAt = toolInsertIndex(messages);
                const row = (message: (typeof messages)[number], index: number) => (
                  <PetMessageRow
                    key={message.id}
                    message={message}
                    petName={pet.name}
                    workspaceId={workspaceId}
                    latest={index === messages.length - 1}
                    canSpeak={voice.canSpeak}
                    onReadAloud={() => {
                      voice.speak(message.text);
                    }}
                  />
                );
                return (
                  <>
                    {messages.slice(0, splitAt).map((message, index) => row(message, index))}
                    <PetWorkTools
                      client={client}
                      runtime={runtime}
                      workspaceId={workspaceId}
                      petId={pet.id}
                      petName={pet.name}
                      mode={mode}
                      onChange={setRuntime}
                      onNeedsDecisionChange={reportNeedsDecision}
                    />
                    {messages
                      .slice(splitAt)
                      .map((message, offset) => row(message, splitAt + offset))}
                  </>
                );
              })()
            )}
            {running && !hasDraft && !approvalPending ? (
              <div className="flex items-center gap-1" aria-hidden="true">
                <Text variant="note" tone="muted">
                  {pet.name} is thinking
                </Text>
                <span className="flex gap-0.5">
                  <span className="motion-safe:animate-pulse">.</span>
                  <span className="motion-safe:animate-pulse [animation-delay:150ms]">.</span>
                  <span className="motion-safe:animate-pulse [animation-delay:300ms]">.</span>
                </span>
              </div>
            ) : null}
          </PetChatViewport>
          {error || voice.error ? (
            <div className="flex items-center justify-between gap-2 border-t border-divider px-4 py-2">
              <Text role="alert">
                {error ? (errorKind === 'load' ? loadErrorMessage : error) : voice.error}
              </Text>
              {error && retryLabel() ? (
                <Button variant="ghost" onClick={retryError}>
                  {retryLabel()}
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="flex shrink-0 flex-col gap-2 border-t border-divider p-3">
            {shared ? (
              <div className="flex items-center justify-between gap-2 rounded border border-divider bg-surface px-3 py-2">
                <Text variant="note" className="truncate">
                  {shared.label}
                </Text>
                <Button
                  variant="icon"
                  aria-label="Remove shared selection"
                  onClick={() => {
                    setShared(null);
                  }}
                >
                  <Icon icon={X} size="sm" />
                </Button>
              </div>
            ) : null}
            {needsWorkspaceAccessForChip ? (
              <div className="flex items-center justify-between gap-2 rounded border border-divider bg-surface px-3 py-2">
                <Text variant="note">{pet.name} needs workspace access for this.</Text>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setWorkspaceAccess(true);
                    writeWorkspaceAccess(workspaceId, pet.id, true);
                  }}
                >
                  Turn on
                </Button>
              </div>
            ) : null}
            <label htmlFor="pet-message" className="sr-only">
              Message {pet.name}
            </label>
            <div className="flex items-end gap-2">
              <textarea
                id="pet-message"
                ref={input}
                rows={composerRows(draft)}
                maxLength={8000}
                value={draft}
                placeholder={`Message ${pet.name}`}
                enterKeyHint={touchLikeComposer ? undefined : 'send'}
                className={`max-h-48 min-h-11 w-full resize-none rounded border border-divider bg-background p-2 text-foreground ${focusRing}`}
                onChange={(event) => {
                  setDraft(event.currentTarget.value);
                  regenerateRequestId();
                }}
                onKeyDown={onComposerKeyDown}
              />
              {running ? (
                <Button variant="icon" aria-label="Stop response" onClick={() => void interrupt()}>
                  <Icon icon={Square} size="sm" />
                </Button>
              ) : (
                <Button
                  variant="icon"
                  aria-label="Send"
                  disabled={busy || !draft.trim() || runtime.status !== 'connected'}
                  onClick={() => void submit()}
                >
                  <Icon icon={ArrowUp} size="sm" />
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                className={workspaceAccess ? 'bg-accent/15 text-accent-text' : ''}
                aria-pressed={workspaceAccess}
                aria-describedby="pet-workspace-access-hint"
                disabled={running}
                onClick={() => {
                  const next = !workspaceAccess;
                  setWorkspaceAccess(next);
                  writeWorkspaceAccess(workspaceId, pet.id, next);
                }}
              >
                Workspace access
              </Button>
              <Text as="span" variant="note" className="sr-only" id="pet-workspace-access-hint">
                Lets {pet.name} find and read your notes for this message. Changes always ask first.
              </Text>
              <Button
                variant="icon"
                aria-label={hasSelection ? 'Share selected text' : 'Select text on the page first'}
                disabled={!currentItem || !hasSelection}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={shareSelection}
              >
                <Icon icon={TextQuote} size="sm" />
              </Button>
              {voice.canDictate ? (
                <Button
                  variant="icon"
                  aria-label="Dictate"
                  aria-pressed={voice.listening}
                  disabled={running}
                  onClick={voice.dictate}
                >
                  <Icon icon={Mic} size="sm" />
                </Button>
              ) : null}
              {voice.listening || voice.speaking ? (
                <Button variant="icon" aria-label="Stop audio" onClick={voice.stop}>
                  <Icon icon={VolumeX} size="sm" />
                </Button>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function renderMenuLink({
  href,
  children,
  ...rest
}: Parameters<NonNullable<Parameters<typeof Menu>[0]['renderLink']>>[0]) {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

function PetMessageRow({
  message,
  petName,
  workspaceId,
  latest,
  canSpeak,
  onReadAloud,
}: {
  readonly message: NonNullable<PetConnection['messages']>[number];
  readonly petName: string;
  readonly workspaceId: string;
  readonly latest: boolean;
  readonly canSpeak: boolean;
  readonly onReadAloud: () => void;
}): ReactElement {
  if (message.role === 'system')
    return (
      <div data-pet-latest-message={latest ? '' : undefined} className="flex justify-center">
        <Text variant="caption" tone="muted">
          {message.text}
        </Text>
      </div>
    );
  const fromUser = message.role === 'user';
  // A streaming draft (id contains `:draft:`) is never durable text yet, so it is kept out of
  // the viewport's `aria-live="polite"` announcement (a screen reader would otherwise read it
  // out token by token) and shown with a caret instead, in place of the read-aloud action a
  // finished reply gets.
  const isDraft = message.id.includes(':draft:');
  return (
    <div
      data-pet-latest-message={latest ? '' : undefined}
      // Nit 16: the whole draft row - its sr-only speaker label included - opts out of the
      // viewport's live region while streaming, not only the text itself; otherwise the label
      // alone would still be announced token turn by token as the row keeps re-rendering.
      aria-live={isDraft ? 'off' : undefined}
      className={`flex shrink-0 flex-col gap-1 ${fromUser ? 'items-end' : 'items-start'}`}
    >
      <Text as="span" variant="note" className="sr-only">
        {fromUser ? 'You said' : `${petName} said`}
      </Text>
      <div className={fromUser ? 'max-w-[85%] rounded-lg bg-surface px-3 py-2' : 'max-w-[85%]'}>
        <PetMessageText text={message.text} workspaceId={workspaceId} />
        {isDraft ? (
          <span
            aria-hidden="true"
            className="ml-0.5 inline-block h-4 w-0.5 align-middle bg-foreground motion-safe:animate-pulse"
          />
        ) : null}
      </div>
      {!fromUser && !isDraft && canSpeak ? (
        <Button variant="icon" aria-label="Read this reply aloud" onClick={onReadAloud}>
          <Icon icon={Volume2} size="sm" />
        </Button>
      ) : null}
    </div>
  );
}

function PetEmptyState({
  mode,
  petName,
  workspaceAccess,
  suggestions,
  onPick,
}: {
  readonly mode: PetConversationMode;
  readonly petName: string;
  readonly workspaceAccess: boolean;
  readonly suggestions: readonly string[];
  readonly onPick: (suggestion: string) => void;
}): ReactElement {
  // Must-fix 13: the chat copy points at "Workspace access" only while it is still off - once
  // it is on, the paragraph would just be describing a control the person already turned on.
  const copy =
    mode === 'consult'
      ? `Describe what you want to keep track of. ${petName} asks a few questions, proposes a design, and builds a draft under Pet drafts for you to try. Nothing is published.`
      : workspaceAccess
        ? ''
        : `Ask a question. Turn on Workspace access below to let ${petName} find and change your notes.`;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      {copy ? (
        <Text variant="note" tone="muted">
          {copy}
        </Text>
      ) : null}
      <div className="flex flex-wrap justify-center gap-2">
        {suggestions.map((suggestion) => (
          <Button
            key={suggestion}
            variant="secondary"
            onClick={() => {
              onPick(suggestion);
            }}
          >
            {suggestion}
          </Button>
        ))}
      </div>
    </div>
  );
}

function PetSettingsPanel({
  pet,
  workspaceId,
  mode,
  model,
  models,
  running,
  runtime,
  readWithoutAsking,
  headingRef,
  onModelChange,
  onReadWithoutAskingChange,
  onBack,
}: {
  readonly pet: PetProfile;
  readonly workspaceId: string;
  readonly mode: PetConversationMode;
  readonly model: string;
  readonly models: NonNullable<PetConnection['models']>;
  readonly running: boolean;
  readonly runtime: PetConnection | null;
  readonly readWithoutAsking: boolean;
  readonly headingRef: RefObject<HTMLDivElement | null>;
  readonly onModelChange: (model: string) => void;
  readonly onReadWithoutAskingChange: (value: boolean) => void;
  readonly onBack: () => void;
}): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center gap-2 self-start">
        <Button variant="ghost" onClick={onBack}>
          <Icon icon={ArrowLeft} size="sm" />
          Back
        </Button>
        <div ref={headingRef} tabIndex={-1} className="outline-none">
          <Text as="h3" variant="h3">
            Chat settings
          </Text>
        </div>
      </div>
      <label className="flex flex-col gap-2">
        <Text variant="note">Model</Text>
        <Select
          aria-label="Model"
          value={model}
          disabled={running}
          onChange={(event) => {
            onModelChange(event.currentTarget.value);
          }}
        >
          <option value="">Account default</option>
          {model && !models.some((entry) => entry.id === model) ? (
            <option value={model}>{model} (checking availability)</option>
          ) : null}
          {models.map((value) => (
            <option key={value.id} value={value.id}>
              {value.name}
            </option>
          ))}
        </Select>
      </label>
      <Checkbox
        checked={readWithoutAsking}
        onChange={(event) => {
          onReadWithoutAskingChange(event.currentTarget.checked);
        }}
        label={`Read without asking. When Workspace access is on, ${pet.name} can search and read your workspace${
          mode === 'consult' ? ', and check designs,' : ''
        } without asking first. What it reads is sent to ChatGPT. Changes always ask first. Applies on this device.`}
      />
      {runtime?.reason && runtime.status === 'connected' ? (
        <Text variant="note" tone="muted">
          {runtime.reason}
        </Text>
      ) : null}
      <Link to={`/w/${workspaceId}/settings`} className={`underline ${focusRing}`}>
        <Text as="span" variant="note">
          Pet settings
        </Text>
      </Link>
    </div>
  );
}
