# Product

<!-- impeccable:product-schema 1 -->

<!-- Init interview answered from the owner's stated product facts and UX priorities (20 October 2026), not from a live question round. Every fact below is the owner's or read from the repository; nothing else is asserted. -->

## Platform

web

Desktop browser and a phone PWA. Both are first-class, so mobile web stays `web`, not a native platform.

## Users

Productivity enthusiasts who run their personal life in one tool: they capture notes, plan tasks, track habits and review their day. They move between desktop and phone through the day and expect to change data where they see it.

## Product Purpose

Nix is a personal life-OS. It holds notes, collections shown through views (list, board, calendar, checklist, gallery), tasks, habits, My Day, synced calendars, an AI companion ("pet") chat, and publishing of notes as sites. Success is that a person captures, reviews and changes what matters in few steps, without hunting for the right screen.

## Capabilities and Constraints

- Items and collections, with views such as list, board, calendar, checklist and gallery.
- Tasks, habits and a My Day surface; two-way calendar sync.
- The pet: an AI companion reached through a chat.
- Sites publishing (nixsites.com and home installs).
- Runs as a desktop web app and a phone PWA.
- Data states are real: loading, empty, error and partial results are shown honestly.

## Product Principles

1. **Accessibility first.** Contrast, keyboard use, touch targets and screen-reader semantics come before any visual preference.
2. **Simplicity of use.** The common action takes the fewest steps.
3. **Views are not bloated or verbose.** Show less when a view cannot be simplified; do not add chrome or copy to fill space.
4. **Edit where it is shown.** Data on screen is editable in place with few steps; for example habits are editable from My Day.
5. **Chat is beautiful and engaging, without fluff.** The pet chat earns its craft through clarity and rhythm, not decoration.
6. **No decorative additions.** Every element carries information or an action.

## Accessibility & Inclusion

Accessibility is the top priority. The repository requires axe coverage for UI components, a 44px touch target on coarse pointers, a visible keyboard focus ring, and light and dark grounds that follow the system setting. No formal conformance level (such as WCAG 2.2 AA) is recorded by the owner; confirm one before claiming it.

## Open Decisions

- Brand voice, logo and naming commitments are not recorded; none are asserted here.
- No testimonials, customer counts or benchmarks exist to cite.
