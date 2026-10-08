# Nix as a life-OS: the plan after the direction correction

Status: drafted 2026-09-22. Supersedes the Office-parity programme of 2026-09-21, whose built
phases (content-first file page, version history, drive view) are kept because a single person
running their life through Nix wants them too. Its shelved parts are recorded on issues #53, #55
and #57.

## Who this is for

One person who wants their tasks, habits, notes, journal, files, calendar and numbers in one place,
on a laptop and a phone, and who is willing to set things up to get them. Not a team, not an
organisation, not somebody leaving Word. Sharing is "send this page to a friend", not access
control.

## What Nix already has for that person

Notes with a rich editor, an item tree where any item is a container, views over children
(list, board, calendar, timeline, gallery, sheet, chart, habit tracker, drive), properties and
schemas, recurrence, daily notes, templates, a canvas, a formula engine in `packages/sheet`,
backlinks and a graph, a collaboration log with version history, Markdown import and export,
a CLI, a PWA shell, and a companion pet. The MVP-2 compute branch (formulas, rollups, charts over
properties) is built and unmerged; it is the foundation for reviews and dashboards.

## Tracks, in priority order

1. **Reviews and dashboards.** Merge the compute branch (`goal/2.1-2.3-compute`, owner approval
   owed). Then: a weekly review template that rolls up the week's completed tasks, habit streaks,
   journal entries and numbers from sheets; a dashboard view kind composed of chart and rollup
   tiles over any container; "this day last week / month" from daily notes.
2. **Capture from anywhere.** A quick-add box reachable from every screen and from the PWA's
   share target (Web Share Target API), email-to-Nix through the existing worker, and voice memos
   as file items with transcription queued to the worker. Everything captured lands in an Inbox
   container with a triage view.
3. **Reminders.** Due tasks, habit check-ins and recurring events as push notifications (Web Push
   through the PWA's service worker) and as a notification inbox inside the app. Quiet hours and
   per-container muting.
4. **Calendar sync.** Two-way with Google Calendar first, then Apple via CalDAV: external events
   shown in the calendar view, Nix items with dates pushed out, conflicts resolved last-write-wins
   with a visible log.
5. **Move your life in.** Importers for Notion (export zip), Obsidian (vault), Todoist (CSV and
   API) and Apple Notes (HTML export), each mapping to items, properties and files with the same
   loss report the Markdown importer produces.
6. **Phone first.** Offline editing with the draft journal already in place extended to reads
   (cache the last opened items), install prompt, a bottom navigation for the five things done
   most on a phone: today, inbox, capture, habits, search.
7. **Automations.** A small rule engine: when an item's property changes, when a date arrives,
   or on a schedule, then create an item from a template, set a property, or send a reminder.
   Runs in the Go worker; rules are items with a schema so they show in views like anything else.

## Kept from the previous programme

- Version history (#56 follow-ups), with automatic daily versions added for journals.
- Drive view leftovers (#54).
- Public read-only links (#55, re-scoped), the one sharing feature this person needs.
- Export polish (#53, re-scoped) as an occasional need.

## Out of scope

Page setup, headers and footers, print preview, comment threads, track changes, in-tenant ACLs,
groups, Office file previews, and anything whose only user is an organisation.
