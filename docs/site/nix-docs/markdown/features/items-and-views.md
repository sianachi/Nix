# Items and views

## One kind of item

Every item can hold children. There is no special folder type: a note can contain sub-notes, a canvas can contain tasks, and a spreadsheet can contain a reading list. You can nest items as deeply as you like, drag them to a new parent, and move them between workspaces. Nix refuses a move that would put an item inside itself.

An item's body is one of:

- **Note**: rich text with headings, lists, task lists, quotes, code, callouts, tables, images, links, columns, collapsible sections, colour, page breaks and embedded live sections of other notes.
- **Canvas**: a shared drawing surface. See [Canvas and diagrams](nix://item/01a130b0-0b36-7fdb-b62b-91fa0f4cd7d5).
- **Spreadsheet**: a grid with A1 formulas. See [Sheets](nix://item/01a130b0-0ff5-73d0-a7fd-ea8eb993feb7).
- **File**: an uploaded file with immutable versions and a preview.

Deleting an item moves it to the trash, with an Undo straight away and a restore later. Items can be bookmarked, or hidden from your own tree without affecting anyone else.

## Files

Uploaded files keep every version. You can replace a file in place, and Nix previews PDFs and images and has built-in viewers for EPUB, CSV, Markdown, Mermaid, audio, video and plain text. Files are delivered through short-lived signed links rather than through the API, and Nix checks each upload's size, type and checksum before publishing it.

## Views

A view shows a container's children. Every container can have several views, and one of them opens by default. A view can also be composed with a companion view beside or below it.

| View | What it shows |
| --- | --- |
| List | A table of rows with editable cells, optionally gathered into sections by a property |
| Board | Cards in columns, grouped by a single-select property |
| Calendar | Items placed on the day or hour a date property names, with an optional end |
| Gallery | Cards with cover pictures, in small, medium or large sizes |
| Timeline | Bars from a start date to an end date; items without an end are milestones |
| Spreadsheet | The children as rows and their properties as columns, edited with typed controls |
| Form | A form that creates a new child from the container's fields |
| Interactive form | A public form behind a revocable link; each response becomes a child item |
| Smart list | A saved query across containers, such as Today, Next 7 days, Overdue or Assigned to me |
| Chart | Column, pie, line or area charts, or a year grid, counting or totalling a property |
| Checklist | A list of boxes that tick a checkbox property |
| Matrix | Cards placed in a grid by two select or checkbox properties |
| Outline | The subtree as an indented, keyboard-driven outline |
| Drive | Files as a sortable list or a grid of tiles |
| Habit tracker | Habits with check-ins, streaks and charts |
| Finance | Accounts, budgets, transactions and cash flow |

Every view supports filters. List-like views support several sort keys, column summaries and a title search. Filters can combine any-of groups, structural fields such as the item's type, and relative day tokens such as today. Views never copy items; they are different ways of reading the same children.

Guided setup walks you through creating a structured container, and keeps your draft if you switch tabs part way through.

## Interactive forms

An interactive form gives people outside your workspace a way to submit something, such as feedback or a sign-up. It lives behind an opaque link you can revoke at any time. Responses arrive as ordinary child items. A person filling in the form never sees the workspace or anyone else's responses.

## Suggestions

Nix offers suggestions that do not use a language model: possible duplicates, property values you have used before, similar items, free calendar slots and filling a series down a column. They can be switched off.

## Properties

- title: Items and views

