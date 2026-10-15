# Changelog

All notable changes to Nix are recorded here. The format follows Keep a Changelog and the project
follows semantic versioning (`0.x` pre-1.0).

## 0.2.0 - 2026-10-15

### Added

**Views and items**

- New menu: every structured item type under headings, including a Chart recipe.
- Views: resizable columns in list and spreadsheet views, remembered per device.
- Views: a per-view "Open items" setting (Auto, Full page, Dialog, Beside, New tab, None) with a
  context-aware Auto policy. Graph nodes get their own open control (no Beside).
- Views: multi-select with Shift and checkboxes, one selection gesture model, a floating
  selection tray, bulk move and bulk delete with per-item refusals. Board cards and checklist
  lines draw the same checkbox as lists and galleries.
- Views: Rename, Move to and Delete are offered from every view that supports them; a caption
  says what a drop changes; list rows can be dragged onto each other to reparent them.
- Settings: tabs regrouped, with device-only settings marked; settings components reorganised
  into subfolders.
- Settings: interface settings sync across devices through a per-user store
  (`/api/v1/me` settings endpoints); retired keys stay repairable.
- Settings: "Keep notes on this device" toggle (off hides the sync footer) and a Publishing
  toggle for sites.
- Settings: operators see nightly backup status; the Compose and k3s backup jobs record each
  run in a capability-only table.
- Workspaces: personal groups and pins in the workspace menu, managed under Settings >
  Workspace, with clearer group and pin controls.

**Editor**

- Markdown editing mode over the collaborative note, with a losses dialog, a remote-change
  warning and one-step undo.
- `[[` note-link picker in Markdown mode, sharing the item search.

**Pets and chat**

- Providers: Claude (Anthropic) and OpenRouter, with per-person API keys; models that cannot use
  tools are labelled. A per-pet "Apply changes without asking by default" setting, also offered
  in note chats.
- Named, resumable chat threads: rename, search and continue past conversations; the companion
  conversation opens as a pane tab.
- Chat reads the open note (attached by id when unlocked), searches before answering and cites
  its sources. Several notes can be attached to one message.
- Regenerate the last reply and edit the last message, replacing only that turn.
- Code in replies is highlighted (accessible colours, lazy-loaded) with a copy button; a slash
  menu offers the suggestion actions; the pet shows its thinking pose while it works.
- `nixctl pet` gains rename and resume-history operations; `nixctl chat eval` adds context
  cases and citation scoring for the 6.8 baseline.

**MCP**

- Remote Streamable HTTP endpoint (`nixctl mcp --listen`), note and item tools, and a
  Settings > MCP tab for tokens and setup. Setup is documented for Claude Code, Codex and other
  clients.

**CLI and tooling**

- `nixctl stress run --scenario collab-edit`; a stress peer stops at its first failed edit and
  the run stays local.
- ADR-0063 (Nix Sites) and ADR-0064 (git sync, deferred) are tracked in `docs/adr/`.

### Changed

- Sites require `Nix:Sites:Enabled` in addition to a domain and are off everywhere but the
  designated production deployment; every sites route is refused while off.
- `GET /api/v1/me` carries deployment features (sites, MCP endpoint) as display hints.
- The instance operator check is synchronous.
- The Nix reference archive drops internal handovers, plans and runbooks; docs no longer
  describe speech or OpenSearch as current.

### Fixed

- Locks: items under a closed lock are withheld from trash and plugin metadata reads.
- Collab: recovery from a lost lock session, no refusal resync loop, bounded draft state.
- Sites: the serve process stays up when a stored body fails; redirect paths are encoded;
  preview cards drop XML-forbidden characters.
- Pets: provider failures are classified and truncated replies no longer pass as answers; setup
  and runtime follow the selected provider; threads stay valid; long item titles are clipped.
- Calendar workers: all-day switches sync to Google and duplicate pushes stop.
- Settings: one account's settings no longer leak into another's on a shared browser;
  suggestion settings are split from UI settings.
- Graph: labels keep a readable size at every zoom, name the focused node first, try the other
  side of a node before dropping a colliding label, and no longer skip labels that have room.
- Views: container views are told when an item moves; a view's open mode is validated like the
  backend; announcements for automatic column widths.
- Editor: the Markdown link picker sits in flow.
- Chat: the composer stays a plain textbox; the note list persists; copy failures are reported.
- Backup: a missing local status counts as failed; nightly recording is hardened; "off-site"
  shows as never when it has not run, per-step runs are counted and overdue refreshes on a timer.
- Release CI repaired and remote transports secured.

### Security

- Workspace arrangement, provider keys and MCP token management are interactive-only for
  personal access tokens; provider keys are stored protected and never returned.
- PR #160 (chat threads) was merged without a security review; one is owed before release.
