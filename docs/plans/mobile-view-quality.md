# Nix view quality and mobile implementation plan

Work on `feature/mobile-view-quality`, one feature at a time. Do not deploy or push to production. Preserve existing backup and IDE changes. No commits requested.

## Status as of 5 September 2026

Implementation remains in the working tree. The completion and validation record below belongs
to the implementation session; it was not rerun by the documentation audit. Physical-device and
live collaboration limits still apply. This plan does not authorize a commit or deployment.

## Design

Reuse Nix's token palette: background #f2f2f3, surface #e9e9ea, foreground #1d1f20, steel accent #5980a6, muted neutral #7a7a7d. Keep existing body and heading fonts. Left-align writing, preserve a comfortable reading measure, and use space rather than extra panels. Mobile actions float above the keyboard and scroll horizontally; dialogs fill the phone screen. Canvas and graph default to browsing on phones, with explicit spatial modes. No new decorative palette or dashboard card system.

## Sequential features

1. **Item dialogs.** Reuse the full item editor, isolate dialog view/filter state from the parent URL, preserve mounted parent views, support children and nested dialogs, and offer Open as page. Verify focus restoration, dismissal, nested items, and parent state.
2. **Sidebar destinations and pins.** Hide automatic child expansion in navigation; expose explicit server-backed bookmark pins in the sidebar. Preserve root access and provide child access from the item editor. Verify pin/unpin and child creation visibility.
3. **Mobile writing surface.** Replace stacked note chrome with compact floating swipeable actions. Keep title editing, formatting, item actions, and workspace navigation accessible. Verify narrow layouts and editing controls.
4. **Toolbar preference.** Remember always-visible versus hide-while-writing locally, give hidden controls an explicit reveal button, and avoid keyboard obstruction. Verify persistence, typing, reveal, and viewport changes.
5. **Mobile canvas browser.** Offer readable scene content and linked items by default, plus explicit spatial editing. Preserve the same collaborative scene across modes; do not rewrite scene data to adapt layout. Verify content extraction and linked-item dialog actions.
6. **Graph exploration.** Open nodes in dialogs; add searchable connection browsing and a mobile browse default with optional spatial graph. Preserve truncation notices, keyboard access, zoom and layout state. Verify reference navigation and search.
7. **Other mobile views and integrated validation.** Review list, board, calendar, gallery, timeline, spreadsheet, and forms. Adapt dense layouts and touch controls while retaining view meaning. Run selected package checks, frontend guards, build, and available browser/axe checks; record any unverified device behavior.

## Validation

For every feature, select checks with `scripts/changed-path-checks.sh` and run focused behavior checks before continuing. At the end run the full selected package checks and each frontend guard's fixture self-test before its guard. Review UX, structure, and store/performance behavior. Query running Nix services only through nixctl or MCP. Do not treat DOM tests as proof of real mobile keyboard behavior.

## Completion record

All seven features were implemented sequentially on `feature/mobile-view-quality` and remain uncommitted. No push or deployment was performed. The pre-existing IDE and backup changes were preserved.

- Item dialogs reuse the editor and keep parent view state mounted. A Children action exposes descendants even when no custom view exists. Dialog filters use isolated state. Native nested dialogs restore focus and offer Open as page.
- Sidebar expansion is deliberate, independent of child loading or creation. Server-backed bookmarks appear as workspace-scoped pins; manually expanding a branch remains available.
- Mobile notes have floating, horizontally scrollable formatting and item actions, more writing space, a remembered visibility preference, an explicit reveal action, and visual-viewport positioning. Sync warnings remain visible outside the dock's area.
- Mobile canvas opens a content browser over the unchanged collaborative scene. Spatial editing loads on request. Canvas links use item dialogs.
- Graph offers searchable, paged connection browsing on phones, optional spatial mode, and item dialogs. Existing zoom, drag, and keyboard behavior remains covered.
- Mobile boards stack columns; lists and spreadsheet views expose editable records; calendars use agendas; timelines use schedules with rescheduling. Optional grids remain available. Item settings use a full-screen dialog on phones, and the navigation rail appears with the workspace drawer. Existing gallery and form layouts were reviewed and retained.

### Observed validation

- Web: 153 test files, 1,739 tests passed; final focused follow-up: 17 tests passed.
- UI package: 225 tests passed.
- Web and UI lint and type checks passed.
- All four frontend guards and their fixture self-tests passed.
- Local production build passed. Vite reported large output chunks; bundle optimization was not part of this change.
- Dialog Storybook: 12 Chromium stories passed with axe coverage.
- Browser review used the real app with in-memory Core test data, not a live Nix service. Checked mobile note layout, hidden/revealed toolbar, full-screen item dialog, 320-pixel graph layout without page overflow, desktop nested Escape behavior, focus restoration, and Open as page. Mobile note, item dialog, and graph scans reported no violations under axe's WCAG 2 A/AA and 2.1 AA rule tags.
- The temporary browser fixture was removed and its dev server stopped.

### Remaining device proof

Physical iOS/Android software keyboards, Safari behavior, real-device touch scrolling, and live multi-user collaboration were not exercised. Viewport-aware positioning is implemented and Chromium layout behavior was inspected; that is not proof of physical keyboard behavior. No production data was changed.
