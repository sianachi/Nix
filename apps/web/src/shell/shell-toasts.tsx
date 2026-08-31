import { Toast } from '@nix/ui';
import { useState, type ReactNode, type RefObject } from 'react';

export interface ShellToast {
  readonly key: string;
  readonly message: string;
  readonly action?: { readonly label: string; readonly onAction: () => void };
  readonly autoFocus?: false;
}

const MAX_SHELL_TOASTS = 2;

export interface ShellToastController {
  readonly toasts: readonly ShellToast[];
  readonly push: (toast: ShellToast) => void;
  readonly dismiss: (key: string) => void;
}

/** Holds the bounded undo/notices queue owned by the shell. */
export function useShellToasts(): ShellToastController {
  const [toasts, setToasts] = useState<readonly ShellToast[]>([]);

  function push(toast: ShellToast): void {
    setToasts((current) => {
      const next = [...current.filter((existing) => existing.key !== toast.key), toast];
      return next.length > MAX_SHELL_TOASTS ? next.slice(next.length - MAX_SHELL_TOASTS) : next;
    });
  }

  function dismiss(key: string): void {
    setToasts((current) => current.filter((toast) => toast.key !== key));
  }

  return { toasts, push, dismiss };
}

export function ShellToasts({
  toasts,
  treeRegionRef,
  onDismiss,
}: {
  readonly toasts: readonly ShellToast[];
  readonly treeRegionRef: RefObject<HTMLDivElement | null>;
  readonly onDismiss: (key: string) => void;
}): ReactNode {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="fixed inset-x-4 bottom-4 z-[25] mx-auto flex max-w-sm flex-col gap-2 sm:inset-x-auto sm:left-4 sm:right-auto">
      {toasts.map((toast) => (
        <Toast
          key={toast.key}
          message={toast.message}
          // Omit optional props when absent so exactOptionalPropertyTypes preserves Toast's defaults.
          {...(toast.action === undefined ? {} : { action: toast.action })}
          {...(toast.autoFocus === false ? { autoFocus: false } : {})}
          onDismiss={() => {
            onDismiss(toast.key);
          }}
          returnFocusRef={treeRegionRef}
        />
      ))}
    </div>
  );
}
