import { Button, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { useMobileToolbarPreference } from './mobile-toolbar-preference';

/** One quiet action surface, with horizontal scrolling instead of wrapped rows. */
export function MobileNoteToolbar({
  formatting,
  actions,
  editor,
}: {
  readonly formatting: ReactNode;
  readonly editor?: Editor;
  readonly actions?: ReactNode;
}): ReactNode {
  const visibility = useMobileToolbarPreference((state) => state.visibility);
  const setVisibility = useMobileToolbarPreference((state) => state.setVisibility);
  const saved = useMobileToolbarPreference((state) => state.saved);
  const [hidden, setHidden] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editor || visibility !== 'while-writing') return;
    const writing = (): void => {
      if (editor.isFocused) setHidden(true);
    };
    editor.on('update', writing);
    return () => {
      editor.off('update', writing);
    };
  }, [editor, visibility]);
  useEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const dock = dockRef.current;
        const parent = dock?.parentElement;
        if (!dock || !parent) return;
        const bottom = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;
        dock.style.setProperty(
          '--keyboard-inset',
          `${String(Math.max(0, parent.getBoundingClientRect().bottom - bottom))}px`,
        );
      });
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (dockRef.current?.parentElement) observer?.observe(dockRef.current.parentElement);
    measure();
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      viewport?.removeEventListener('resize', measure);
      viewport?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, []);
  const collapsed = visibility === 'while-writing' && hidden;
  const [section, setSection] = useState<'formatting' | 'item'>('formatting');
  return (
    // design-token-exempt: keyboard inset is measured from the runtime visual viewport; safe-area is supplied by the device.
    <div
      ref={dockRef}
      className="absolute inset-x-3 bottom-[max(calc(var(--keyboard-inset,0%)+var(--spacing)*3),env(safe-area-inset-bottom))] z-20 rounded-md border border-divider bg-background p-1 shadow-md"
    >
      {collapsed ? (
        <Button
          variant="ghost"
          onClick={() => {
            setHidden(false);
          }}
        >
          Show writing tools
        </Button>
      ) : (
        <>
          {!saved ? (
            <Text as="p" variant="caption">
              Preference applies to this session; browser storage is unavailable.
            </Text>
          ) : null}
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="ghost"
              aria-pressed={section === 'formatting'}
              onClick={() => {
                setSection('formatting');
              }}
            >
              Formatting
            </Button>
            {actions ? (
              <Button
                variant="ghost"
                aria-pressed={section === 'item'}
                onClick={() => {
                  setSection('item');
                }}
              >
                Item
              </Button>
            ) : null}
            <label className="ml-auto flex items-center gap-1 px-2 py-1">
              <input
                type="checkbox"
                checked={visibility === 'while-writing'}
                onChange={(event) => {
                  setVisibility(event.target.checked ? 'while-writing' : 'always');
                  setHidden(false);
                }}
              />
              <Text as="span" variant="caption">
                Hide while writing
              </Text>
            </label>
          </div>
          <div
            className="overflow-x-auto overscroll-x-contain"
            aria-label={section === 'formatting' ? 'Formatting actions' : 'Item actions'}
          >
            {section === 'formatting' ? formatting : actions}
          </div>
        </>
      )}
    </div>
  );
}
