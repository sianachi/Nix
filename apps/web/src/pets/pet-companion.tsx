import {
  isCanceledError,
  pets,
  type PetConnection,
  type PetProfile,
  type PetSettings,
} from '@nix/api-client';
import { Button, Select, Text, focusRing } from '@nix/ui';
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApiClient } from '../api/api-client-provider';
import { useWorkspace } from '../workspaces/workspace-context';
import { useNarrowViewport } from '../layout/viewport';
import { useMobileKeyboard } from '../layout/use-mobile-keyboard';
import { useBackDismiss } from '../layout/use-back-dismiss';
import { PetAvatar, type PetAnimationState } from './pet-avatar';
import { usePetSettings } from './use-pet-settings';
import { usePetVoice } from './use-pet-voice';
import {
  readConversationModel,
  readDevicePreference,
  readPetPosition,
  writePetPosition,
  writeConversationModel,
} from './device-preferences';
import { PetWorkTools } from './pet-work-tools';
import { PetConnectionPanel } from './pet-connection-panel';
import { PetHistory } from './pet-history';
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
  const keyboardVisible = useMobileKeyboard(narrow);
  const launcherHidden = open || (narrow && keyboardVisible);
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
          workspaceId={workspaceId}
          pet={pet}
          settings={settings}
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

function Conversation({
  workspaceId,
  pet,
  settings,
  narrow,
  onClose,
}: {
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
  readonly narrow: boolean;
  readonly onClose: () => void;
}) {
  const client = useApiClient();
  const [search] = useSearchParams();
  const currentItem = search.get('item');
  const [runtime, setRuntime] = useState<PetConnection | null>(null);
  const [draft, setDraft] = useState('');
  const [shared, setShared] = useState<{ itemId: string; text: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [model, setModel] = useState(() => readConversationModel(workspaceId, pet.id));
  const [models, setModels] = useState<NonNullable<PetConnection['models']>>([]);
  const [workspaceAccess, setWorkspaceAccess] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const narrationPending = useRef(false);
  const voice = usePetVoice((text) => {
    setDraft((old) => `${old}${old ? ' ' : ''}${text}`.slice(0, 8000));
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

  // Mounted only while the conversation is open (the caller renders it conditionally), so the
  // browser Back gesture dismisses the full-screen phone dialog for as long as it is showing.
  useBackDismiss(narrow, onClose);

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
    const controller = new AbortController();
    lifetime.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    // On a phone the dialog itself takes focus first (its name is announced, and Tab starts
    // from a known place); on a wide screen the composer keeps taking it directly, as before.
    if (narrow) dialog.current?.focus();
    else input.current?.focus();
    void client
      .execute(pets.runtime({ operation: 'models' }), { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setModels(value.models ?? []);
      })
      .catch(() => {
        /* The provider default remains available if model discovery fails. */
      });
    const poll = async () => {
      try {
        const result = await client.execute(
          pets.runtime({ operation: 'read', workspaceId, petId: pet.id }),
          { signal: controller.signal },
        );
        if (!isAborted(controller.signal)) setRuntime(result);
      } catch (cause) {
        if (!isCanceledError(cause) && !isAborted(controller.signal))
          setError('Conversation could not be loaded. Check your connection and try Refresh.');
      }
      if (!isAborted(controller.signal))
        timer = setTimeout(() => {
          void poll();
        }, 3000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, workspaceId, pet.id, narrow]);

  useEffect(() => {
    if (!narrationPending.current || runtime?.state !== 'success') return;
    narrationPending.current = false;
    const last = runtime.messages?.at(-1);
    if (settings.narration && last?.role === 'assistant') voice.speak(last.text);
  }, [runtime, settings.narration, voice]);

  async function command(operation: 'send' | 'interrupt' | 'reset' | 'read') {
    const controller = lifetime.current;
    if (busy || !controller || isAborted(controller.signal)) return;
    setBusy(true);
    setError('');
    try {
      const result = await client.execute(
        pets.runtime({
          operation,
          workspaceId,
          petId: pet.id,
          ...(operation === 'send'
            ? {
                requestId,
                text: draft,
                model,
                workspaceAccess,
                ...(shared ? { itemId: shared.itemId, sharedText: shared.text } : {}),
              }
            : {}),
        }),
        { signal: controller.signal },
      );
      if (isAborted(controller.signal)) return;
      setRuntime(result);
      if (operation === 'send') {
        narrationPending.current = true;
        setDraft('');
        setShared(null);
        setRequestId(crypto.randomUUID());
      }
    } catch (cause) {
      if (!isCanceledError(cause) && !isAborted(controller.signal))
        setError(
          'The request could not be confirmed. Refresh before retrying; your draft is preserved.',
        );
    } finally {
      if (!isAborted(controller.signal)) setBusy(false);
    }
  }

  function shareSelection() {
    const text = window.getSelection()?.toString().trim() ?? '';
    if (!currentItem || !text) {
      setError('Select text in the current item, then choose Share selected text.');
      return;
    }
    setShared({ itemId: currentItem, text: text.slice(0, 16000) });
    setError('');
  }

  return (
    <div
      ref={dialog}
      role="dialog"
      tabIndex={-1}
      aria-modal={narrow}
      aria-label={`Conversation with ${pet.name}`}
      className={
        narrow
          ? 'fixed inset-0 z-40 flex h-[var(--phone-dialog-height,100dvh)] w-full flex-col overflow-hidden bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground'
          : 'flex h-[calc(100dvh-var(--spacing)*36)] max-h-192 w-128 max-w-full flex-col overflow-hidden rounded-lg border border-divider bg-background text-foreground shadow-lg'
      }
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
          <Text role="status" variant="note">
            {animation === 'awaiting-approval'
              ? 'Needs approval'
              : running
                ? 'Thinking…'
                : animation === 'success'
                  ? 'Replied'
                  : animation}
          </Text>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <details className="max-h-40 shrink-0 overflow-y-auto border-b border-divider px-4 py-2">
        <summary className={`cursor-pointer ${focusRing}`}>
          <Text as="span" variant="note">
            Chat options and connection
          </Text>
        </summary>
        <div className="flex flex-col gap-3 py-2">
          <Text variant="note" tone="muted">
            Workspace tools run only when enabled and approved. Approved reads share their results
            with ChatGPT.{' '}
            <Link to={`/w/${workspaceId}/settings`} className="underline">
              Connection and pet settings
            </Link>
          </Text>
          {runtime?.reason && runtime.status === 'connected' ? (
            <Text variant="note" tone="muted">
              {runtime.reason}
            </Text>
          ) : null}
          {runtime && runtime.status !== 'connected' ? <PetConnectionPanel compact /> : null}
          <label className="flex flex-col gap-2">
            <Text variant="note">Codex model</Text>
            <Select
              aria-label="Codex model"
              value={model}
              disabled={running || busy}
              onChange={(event) => {
                setModel(event.currentTarget.value);
                writeConversationModel(workspaceId, pet.id, event.currentTarget.value);
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
        </div>
      </details>
      <PetChatViewport
        latestKey={`${messages.at(-1)?.id ?? ''}:${runtime?.tools?.at(-1)?.id ?? ''}`}
      >
        {runtime?.state === 'error' ? (
          <Text role="alert">
            {runtime.reason || 'The response did not finish. Refresh and try again.'}
          </Text>
        ) : null}
        {messages.length === 0 ? (
          <Text variant="note">
            Ask a question, or enable workspace tools to find notes, write content, and organise
            your work.
          </Text>
        ) : (
          messages.map((message, index) => (
            <div
              key={message.id}
              data-pet-latest-message={index === messages.length - 1 ? '' : undefined}
              className={`flex shrink-0 flex-col gap-2 ${message.role === 'user' ? 'rounded-lg bg-surface p-3' : ''}`}
            >
              {message.role === 'system' ? (
                <Text variant="note" tone="muted">
                  {message.text}
                </Text>
              ) : (
                <>
                  <Text variant="note" tone="muted">
                    {message.role === 'user' ? 'You' : pet.name}
                  </Text>
                  <PetMessageText text={message.text} workspaceId={workspaceId} />
                  {message.role === 'assistant' && voice.canSpeak ? (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        voice.speak(message.text);
                      }}
                    >
                      Read aloud
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          ))
        )}
        {runtime ? (
          <PetWorkTools
            client={client}
            runtime={runtime}
            workspaceId={workspaceId}
            petId={pet.id}
            onChange={setRuntime}
          />
        ) : null}
        {error || voice.error ? <Text role="alert">{error || voice.error}</Text> : null}
      </PetChatViewport>
      <div className="flex max-h-[50dvh] shrink-0 flex-col gap-2 overflow-y-auto border-t border-divider p-3">
        {shared ? (
          <div className="flex flex-col gap-2">
            <Text variant="note">
              Shared selection ({shared.text.length} characters): {shared.text.slice(0, 120)}
            </Text>
            <Button
              variant="ghost"
              onClick={() => {
                setShared(null);
              }}
            >
              Remove shared text
            </Button>
          </div>
        ) : null}
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) void command('send');
          }}
        >
          <label htmlFor="pet-message">
            <Text variant="note">Message {pet.name}</Text>
          </label>
          <textarea
            id="pet-message"
            ref={input}
            rows={2}
            maxLength={8000}
            value={draft}
            className={`max-h-32 w-full resize-none rounded border border-divider bg-background p-2 text-foreground ${focusRing}`}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setRequestId(crypto.randomUUID());
            }}
          />
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={workspaceAccess}
              disabled={running}
              onChange={(event) => {
                setWorkspaceAccess(event.currentTarget.checked);
              }}
            />
            <Text variant="note">Allow workspace tools for this message (approval required)</Text>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={busy || running || !draft.trim() || runtime?.status !== 'connected'}
            >
              Send
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void command('read');
              }}
            >
              Refresh
            </Button>
            {running ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void command('interrupt');
                }}
              >
                Stop response
              </Button>
            ) : null}
          </div>
        </form>
        <details>
          <summary className={`cursor-pointer ${focusRing}`}>
            <Text as="span" variant="note">
              More actions and history
            </Text>
          </summary>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={shareSelection}
            >
              Share selected text
            </Button>
            {voice.canDictate ? (
              <Button variant="ghost" disabled={running} onClick={voice.dictate}>
                Dictate
              </Button>
            ) : (
              <Text variant="note" tone="muted">
                Dictation unavailable in this browser
              </Text>
            )}
            {voice.listening || voice.speaking ? (
              <Button variant="secondary" onClick={voice.stop}>
                Stop audio
              </Button>
            ) : null}
            <Button
              variant="ghost"
              disabled={busy || running}
              onClick={() => {
                void command('reset');
              }}
            >
              New conversation
            </Button>
            <Button
              variant="ghost"
              disabled={!messages.length}
              onClick={() => {
                const text = messages
                  .filter((message) => message.role !== 'system')
                  .map(
                    (message) => `${message.role === 'user' ? 'You' : pet.name}\n\n${message.text}`,
                  )
                  .join('\n\n---\n\n');
                const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
                const link = document.createElement('a');
                link.href = url;
                link.download = 'nix-companion-conversation.md';
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export conversation
            </Button>
          </div>
          <PetHistory client={client} workspaceId={workspaceId} petId={pet.id} name={pet.name} />
        </details>
      </div>
    </div>
  );
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
