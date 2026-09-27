import { type PetConnection, type PetProfile, type PetSettings } from '@nix/api-client';
import { Button, Icon, Menu, Segmented, Select, Text, focusRing, type MenuEntry } from '@nix/ui';
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
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApiClient } from '../api/api-client-provider';
import { useWorkspace } from '../workspaces/workspace-context';
import { useNarrowViewport } from '../layout/viewport';
import { useMobileKeyboard } from '../layout/use-mobile-keyboard';
import { useBackDismiss } from '../layout/use-back-dismiss';
import { PetAvatar, type PetAnimationState } from './pet-avatar';
import { usePetSettings } from './use-pet-settings';
import { usePetVoice } from './use-pet-voice';
import { usePetRuntime } from './use-pet-runtime';
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
 * "listening" or "hover", only what the person actually needs to know right now. */
function statusText(
  animation: PetAnimationState,
  running: boolean,
  errored: boolean,
): string {
  if (errored) return 'Something went wrong';
  if (animation === 'awaiting-approval') return 'Waiting for your approval';
  if (running) return 'Thinking';
  return 'Ready';
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
        <Conversation
          key={`${workspaceId}:${pet.id}:${mode}`}
          workspaceId={workspaceId}
          pet={pet}
          settings={settings}
          mode={mode}
          onModeChange={setMode}
          narrow={narrow}
          onClose={() => {
            setOpen(false);
            setOpenAnchor(null);
            returnFocus.current = true;
          }}
        />
      ) : null}
      <Button
        ref={launcher}
        variant="ghost"
        className={`h-auto touch-none p-1 ${launcherHidden ? 'hidden' : ''}`}
        aria-expanded={open}
        aria-label={open ? `Close ${pet.name}` : `Talk with ${pet.name}`}
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
      </Button>
    </aside>
  );
}

type ConversationPanel = 'chat' | 'settings' | 'history';

function Conversation({
  workspaceId,
  pet,
  settings,
  mode,
  onModeChange,
  narrow,
  onClose,
}: {
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
  readonly mode: PetConversationMode;
  readonly onModeChange: (mode: PetConversationMode) => void;
  readonly narrow: boolean;
  readonly onClose: () => void;
}) {
  const client = useApiClient();
  const [search] = useSearchParams();
  const currentItem = search.get('item');
  const {
    runtime,
    models,
    busy,
    error,
    setRuntime,
    regenerateRequestId,
    send,
    interrupt,
    reset,
    reload,
  } = usePetRuntime(workspaceId, pet.id, mode);
  const [panel, setPanel] = useState<ConversationPanel>('chat');
  const [draft, setDraft] = useState('');
  const [shared, setShared] = useState<{ itemId: string; text: string } | null>(null);
  const [model, setModel] = useState(() => readConversationModel(workspaceId, pet.id, mode));
  const [workspaceAccess, setWorkspaceAccess] = useState(() => readWorkspaceAccess(workspaceId, pet.id));
  const [readWithoutAsking, setReadWithoutAsking] = useState(() => readReadWithoutAsking());
  const input = useRef<HTMLTextAreaElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const narrationPending = useRef(false);
  const voice = usePetVoice((text) => {
    setDraft((old) => `${old}${old ? ' ' : ''}${text}`.slice(0, 8000));
    regenerateRequestId();
  });
  const messages = runtime?.messages ?? [];
  const running = runtime?.state === 'thinking';
  const approvalPending = runtime?.tools?.some((tool) => tool.status === 'pending') ?? false;
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

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dialog.current?.contains(document.activeElement)) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
    };
  }, [onClose]);

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
    if (settings.narration && last?.role === 'assistant') voice.speak(last.text);
  }, [runtime, settings.narration, voice]);

  function shareSelection() {
    const text = window.getSelection()?.toString().trim() ?? '';
    if (!currentItem || !text) return;
    setShared({ itemId: currentItem, text: text.slice(0, 16000) });
  }

  async function submit() {
    if (!draft.trim() || busy || runtime?.status !== 'connected') return;
    const ok = await send({
      text: draft,
      model,
      workspaceAccess,
      ...(shared ? { itemId: shared.itemId, sharedText: shared.text } : {}),
    });
    if (ok) {
      narrationPending.current = true;
      setDraft('');
      setShared(null);
    }
  }

  function onComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
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
      label: 'Settings',
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

  const suggestions =
    mode === 'consult'
      ? ['Plan my reading', 'Track a job hunt', 'Weekly meal plan']
      : [
          ...(currentItem ? ['Summarize this page'] : []),
          'Find my notes about...',
          'Add a status field to this list',
        ].slice(0, 3);

  const dialogClass = narrow
    ? 'fixed inset-0 z-40 flex h-[var(--phone-dialog-height,100dvh)] w-full flex-col overflow-hidden bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground'
    : 'flex h-[calc(100dvh-var(--spacing)*36)] max-h-192 w-128 max-w-full flex-col overflow-hidden rounded-lg border border-divider bg-background text-foreground shadow-lg';

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
          <div className="size-14 shrink-0 overflow-visible">
            <div className="origin-top-left scale-50">
              <PetAvatar
                appearance={pet.appearance}
                motion={settings.motion}
                state={animation}
                label={`${pet.name}: ${animation}`}
              />
            </div>
          </div>
          <Text variant="h3" as="h2">
            {pet.name}
          </Text>
          <Text role="status" variant="note" tone="muted">
            {statusText(animation, running, errored)}
          </Text>
        </div>
        <div className="flex items-center gap-2">
          <Segmented
            label="Conversation mode"
            options={CONVERSATION_MODE_OPTIONS}
            value={mode}
            onChange={onModeChange}
          />
          <Menu label="Conversation actions" items={menuItems} renderLink={renderMenuLink}>
            {(trigger) => (
              <Button {...trigger} variant="icon" aria-label="More conversation actions">
                <Icon icon={MoreHorizontal} size="sm" />
              </Button>
            )}
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
          onModelChange={(next) => {
            setModel(next);
            writeConversationModel(workspaceId, pet.id, mode, next);
          }}
          onReadWithoutAskingChange={(next) => {
            setReadWithoutAsking(next);
            writeReadWithoutAsking(next);
          }}
          onBack={() => {
            setPanel('chat');
          }}
        />
      ) : panel === 'history' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
          <Button
            variant="ghost"
            onClick={() => {
              setPanel('chat');
            }}
          >
            <Icon icon={ArrowLeft} size="sm" />
            Back
          </Button>
          <PetHistory workspaceId={workspaceId} petId={pet.id} name={pet.name} client={client} mode={mode} />
        </div>
      ) : runtime && runtime.status !== 'connected' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <PetConnectionPanel />
        </div>
      ) : (
        <>
          <PetChatViewport
            latestKey={`${messages.at(-1)?.id ?? ''}:${runtime?.tools?.at(-1)?.id ?? ''}:${running ? 'thinking' : 'idle'}`}
          >
            {runtime?.state === 'error' ? (
              <Text role="alert">
                {runtime.reason || 'The response did not finish. Try again.'}
              </Text>
            ) : null}
            {messages.length === 0 ? (
              <PetEmptyState
                mode={mode}
                suggestions={suggestions}
                onPick={(suggestion) => {
                  setDraft(suggestion);
                  regenerateRequestId();
                  input.current?.focus();
                }}
              />
            ) : (
              messages.map((message, index) => (
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
              ))
            )}
            {runtime ? (
              <PetWorkTools
                client={client}
                runtime={runtime}
                workspaceId={workspaceId}
                petId={pet.id}
                petName={pet.name}
                mode={mode}
                onChange={setRuntime}
              />
            ) : null}
            {running ? (
              <div className="flex items-center gap-1" aria-hidden="true">
                <Text variant="note" tone="muted">
                  {pet.name} is thinking
                </Text>
                <span className="flex gap-0.5">
                  <span className="motion-safe:animate-pulse">.</span>
                  <span className="motion-safe:animate-pulse">.</span>
                  <span className="motion-safe:animate-pulse">.</span>
                </span>
              </div>
            ) : null}
          </PetChatViewport>
          {error || voice.error ? (
            <div className="flex items-center justify-between gap-2 border-t border-divider px-4 py-2">
              <Text role="alert">{error || voice.error}</Text>
              <Button
                variant="ghost"
                onClick={() => {
                  void reload();
                }}
              >
                Try again
              </Button>
            </div>
          ) : null}
          <div className="flex shrink-0 flex-col gap-2 border-t border-divider p-3">
            {shared ? (
              <div className="flex items-center justify-between gap-2 rounded border border-divider bg-surface px-3 py-2">
                <Text variant="note" className="truncate">
                  {shared.text.slice(0, 120)}
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
                  disabled={busy || !draft.trim() || runtime?.status !== 'connected'}
                  onClick={() => void submit()}
                >
                  <Icon icon={ArrowUp} size="sm" />
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={workspaceAccess ? 'secondary' : 'ghost'}
                aria-pressed={workspaceAccess}
                disabled={running}
                onClick={() => {
                  const next = !workspaceAccess;
                  setWorkspaceAccess(next);
                  writeWorkspaceAccess(workspaceId, pet.id, next);
                }}
              >
                {workspaceAccess ? 'Workspace on' : 'Workspace off'}
              </Button>
              <Button
                variant="icon"
                aria-label="Share selected text"
                disabled={!currentItem}
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
  return (
    <div
      data-pet-latest-message={latest ? '' : undefined}
      className={`flex shrink-0 flex-col gap-1 ${fromUser ? 'items-end' : 'items-start'}`}
    >
      <Text as="span" variant="note" className="sr-only">
        {fromUser ? 'You said' : `${petName} said`}
      </Text>
      <div className={fromUser ? 'max-w-[85%] rounded-lg bg-surface px-3 py-2' : 'max-w-[85%]'}>
        <PetMessageText text={message.text} workspaceId={workspaceId} />
      </div>
      {!fromUser && canSpeak ? (
        <Button variant="icon" aria-label="Read this reply aloud" onClick={onReadAloud}>
          <Icon icon={Volume2} size="sm" />
        </Button>
      ) : null}
    </div>
  );
}

function PetEmptyState({
  mode,
  suggestions,
  onPick,
}: {
  readonly mode: PetConversationMode;
  readonly suggestions: readonly string[];
  readonly onPick: (suggestion: string) => void;
}): ReactElement {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <Text variant="note" tone="muted">
        {mode === 'consult'
          ? 'Describe what you want to keep track of. Your pet asks a few questions, proposes a design, and builds a draft under Pet drafts for you to try. Nothing is published.'
          : 'Ask a question, or turn on workspace access to find notes, write content, and organise your work.'}
      </Text>
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
  readonly onModelChange: (model: string) => void;
  readonly onReadWithoutAskingChange: (value: boolean) => void;
  readonly onBack: () => void;
}): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <Button variant="ghost" onClick={onBack}>
        <Icon icon={ArrowLeft} size="sm" />
        Back
      </Button>
      <label className="flex flex-col gap-2">
        <Text variant="note">Codex model</Text>
        <Select
          aria-label="Codex model"
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
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={readWithoutAsking}
          onChange={(event) => {
            onReadWithoutAskingChange(event.currentTarget.checked);
          }}
        />
        <Text variant="note">
          Let {pet.name} read your workspace without asking{mode === 'consult' ? ', and check its design,' : ''}{' '}
          each time
        </Text>
      </label>
      {runtime?.reason && runtime.status === 'connected' ? (
        <Text variant="note" tone="muted">
          {runtime.reason}
        </Text>
      ) : null}
      <Text variant="note" tone="muted">
        Reads share their results with ChatGPT. Changes always ask first.
      </Text>
      <Link to={`/w/${workspaceId}/settings`} className="underline">
        <Text as="span" variant="note">
          Connection and pet settings
        </Text>
      </Link>
    </div>
  );
}
