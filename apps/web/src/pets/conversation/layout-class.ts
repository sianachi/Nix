export function dialogClass(layout: 'floating' | 'fullscreen' | 'page'): string {
  return layout === 'fullscreen'
    ? '@container fixed inset-x-0 top-[var(--phone-dialog-top,0)] z-40 flex h-[var(--phone-dialog-height,100dvh)] min-w-0 w-full flex-col overflow-hidden bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground outline-none'
    : layout === 'page'
      ? '@container flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-background text-foreground outline-none'
      : '@container flex h-[calc(100dvh-var(--spacing)*36)] max-h-192 min-w-0 w-128 max-w-full flex-col overflow-hidden rounded-lg border border-divider bg-background text-foreground shadow-lg outline-none';
}
