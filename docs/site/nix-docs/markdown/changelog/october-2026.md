# October 2026

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

## The companion pet

- Design and building now happen in the one chat, without a separate Design mode.
- Block-level note edits, with the changed block shown before and after on the approval card.
- The pet can read your calendar, complete tasks, and inspect and refine views.
- Apply without asking, for one conversation at a time.

## nixctl

- Browser-approved, renewable sign-in for `nixctl`, so you no longer need to paste a token on your own machine.

## Accounts

- Verified email addresses and pending workspace invitations are refreshed when you sign in.

## Self-hosting

- Fewer services to run: search now runs inside PostgreSQL, so the separate search index and its worker are gone, as is the central logging stack.
- CI rebuilds only the images whose sources changed, and retags the rest.

