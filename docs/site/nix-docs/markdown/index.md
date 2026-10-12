# Nix

Everything in Nix is an item. A note, a project, a reading list and a budget are the same kind of thing: an item with an optional body, a set of properties and any number of children. What changes is how you look at those children. The same tasks can be a list on Monday, a board on Tuesday and a calendar on Friday, without copying anything.

## What you can do with it

- **Write.** Rich collaborative notes with headings, tables, callouts, columns, collapsible sections, code, images and Mermaid diagrams. Optional Vim and Emacs keyboard modes.
- **Structure.** Give a container fields that cascade to everything inside it, then add formulas, rollups and charts.
- **See things differently.** List, board, calendar, gallery, timeline, spreadsheet, chart, form, smart list, checklist, matrix, outline, drive, habit tracker and finance views over the same children.
- **Plan.** Due dates, recurring tasks, reminders with quiet hours, automations and two-way sync with Google Calendar and Microsoft Outlook.
- **Draw and calculate.** Canvas bodies for diagrams and whiteboards, spreadsheet bodies with A1 formulas.
- **Work offline.** Install Nix as an app, download your notes, edit them without a connection and let them sync when you are back.
- **Script it.** `nixctl` gives you the workspace from a terminal, with JSON output and an MCP server for agent tools.
- **Leave whenever you like.** Export a page or a whole subtree as a lossless `.nix` archive, Markdown, PDF or Word, with any losses reported before you export.
- **Publish.** Turn any page tree into a static website. This site is one.

## Why it is built this way

**A life is split across too many tools.** Notes, tasks, dates, habits, money and files usually live in separate applications that do not talk to each other. Nix keeps them in one tree.

**Rigid hierarchies do not match real work.** Separating an item's body from its views means structure follows what you need, not what the app was designed for.

**Permission failures are security failures.** Roles live in the database, permission checks happen while queries run, and the web app, the CLI and MCP all go through the same authorisation path.

**Self-hosted software should be safe to operate.** Nix ships CI-built images for amd64 and arm64, keeps derived data rebuildable, and reports partial or lossy results instead of implying success.

