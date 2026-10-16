# October 2026

# October 2026

## Version 0.3.0

### Sites

- Attach an MP4 or WebM video (up to 50 MB) to a note and it plays on your published site, with a download link underneath. Videos are published exactly as you recorded them, so remove any location or device information first.
- A file you remove from your site stops being served as soon as you publish again.
- Publishing now lists posts that were left out because they are scheduled, undated or have an invalid date.
- Site approvals can be handled in Settings: approvers see waiting sites, with the hostnames and who asked, and approve or reject them there.
- An Administrators tab in Settings lets tenant administrators add and remove other administrators, and lets approvers name more site approvers.

### My Day and views

- My Day shows the tasks that are due, overdue or assigned to you and the habits scheduled today, and says when a limit hides some of them. `nixctl my-day` reads the same list.
- Outline, timeline and calendar views use the same multi-select as the other views, and habit trackers gain the shared item actions.
- Drive uses checkboxes, range selection and a floating bulk-action tray.
- Dynamic fields, workspace groups and durable group chats.
- Turn a note into sensible views, or write a note from your views, with the original always kept. PDF, Word and Markdown exports now include readable versions of every view.

### nixctl

- `nixctl canvas` reads and writes canvases.

### Fixes

- Selecting items across a long sidebar and deleting them works, and view selection keeps focus and native gestures.
- Mermaid diagrams load only when one is shown.
- Archive exports are identical across time zones.

## Offline notes

- The installed app can download every note you have access to, open them with no connection, edit and create notes offline, and sync when you are back. See [Collaboration and offline](nix://item/01a130b0-0b97-7da4-aaf4-8ece03849441).

## Sites

- Publish any page tree as a static website, with a docs layout and a blog and portfolio layout, stable paths, rollback and three republish modes. This site is the first one. See [Sites](nix://item/01a130b0-106e-79a7-868c-435fae417b52).

## Views, queries and charts

- Three new views: Checklist, Matrix and Outline.
- List views can be gathered into sections, and smart lists appear in the navigation rail.
- Filters on every view, several sort keys, wider grouping and column summaries.
- Filters with any-of groups, structural fields such as the kind of item, and relative day tokens.
- A title search and saved filters inline above each view.
- Charts gained column, pie, line and area types, a time axis, series split by a choice field, and a year grid. Habit insights show a year grid too.
- Spreadsheet view cells are edited with controls that match each field's type.
- Ad-hoc queries and aggregates across a workspace.
- Each view has an "Open items" setting: Auto, Full page, Dialog, Beside, New tab or None. Graph nodes have their own control.
- Multi-select in lists, galleries, boards and checklists with Shift or checkboxes, and a floating tray for bulk move and delete. Items that cannot move say why.
- Resizable columns in list and spreadsheet views, remembered per device. Drag list rows onto each other to reparent them.
- Rename, Move to and Delete are available from every view that supports them.

## Formulas

- An extended formula language and a full formula guide with worked examples, error explanations and limits.

## Calendar and protections

- Two-way sync with Google Calendar and Microsoft Outlook, managed from a Calendars tab in settings, with a visible sync log.
- Drag and resize calendar entries in 15-minute steps, and a fixed month grid.
- Item protections: no delete and no children, and managed items for linked calendars.

## Writing and navigation

- A six-entry New menu that asks for a title and a location for every new item.
- Usable Vim and Emacs modes.
- Responsive Zen mode and better touch editing.
- Simpler writing and navigation on phones.
- Model-free suggestions across notes and views, with an off switch.
- A rebuilt graph: camera with fit, pan and zoom, folding branches, neighbourhoods, size by references, a time view and new layouts.
- Hide an item's children from your workspace tree.
- Improved finance and habit workflows, and clearer daily note errors.
- A Markdown editing mode for notes, with a dialog listing anything Markdown cannot hold, a warning when someone else edits, one-step undo and a `[[` link picker.
- The New menu groups every item type under headings, including a Chart recipe.
- Personal workspace groups and pins in the workspace menu, managed under Settings > Workspace.
- Graph labels stay readable at every zoom and no longer collide.

## The companion pet

- Design and building now happen in the one chat, without a separate Design mode.
- Block-level note edits, with the changed block shown before and after on the approval card.
- The pet can read your calendar, complete tasks, and inspect and refine views.
- Apply without asking, for one conversation at a time.
- Claude and OpenRouter join the existing providers, each person using their own key. Models that cannot use tools are labelled.
- Chat threads: name, search, resume and reopen past conversations, including as a tab beside your note.
- Chat reads the open note, searches before answering and cites sources. Attach several notes to one message.
- Regenerate or edit the last turn. Code in replies is highlighted and can be copied.
- "Apply changes without asking" can be set per pet, including in note chats.

## nixctl

- Browser-approved, renewable sign-in for `nixctl`, so you no longer need to paste a token on your own machine.

## Accounts

- Verified email addresses and pending workspace invitations are refreshed when you sign in.

## Self-hosting

- Fewer services to run: search now runs inside PostgreSQL, so the separate search index and its worker are gone, as is the central logging stack.
- CI rebuilds only the images whose sources changed, and retags the rest.

## MCP

- A remote MCP endpoint over Streamable HTTP, with note and item tools and a Settings > MCP tab for tokens. Setup guides cover Claude Code, Codex and other clients.

## Settings

- Tabs are regrouped and device-only settings are marked. Interface settings now sync across your devices.
- A "Keep notes on this device" toggle and a Publishing toggle for sites.
- Operators see nightly backup status in Settings.

## Fixes and security

- Items under a closed lock no longer appear in trash or plugin metadata, and collaboration recovers from a lost lock session.
- Google Calendar all-day events sync correctly and no longer push twice.
- Sites keep serving when one stored page fails.
- One account's settings no longer show up for another on a shared browser.
- Workspace arrangement, provider keys and MCP tokens can be changed only interactively, not with a personal access token. Provider keys are stored protected and never shown again.

