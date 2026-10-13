# Changelog

All notable changes to Nix are recorded here. The format follows Keep a Changelog and the project
follows semantic versioning (`0.x` pre-1.0).

## Unreleased

### Added

- New menu: every structured item type under headings, including a Chart recipe.
- Views: resizable columns in list and spreadsheet views, remembered per device; a per-view
  "Open items" setting (Auto, Full page, Dialog, Beside) with a context-aware Auto policy.
- Views: multi-select with Shift and checkboxes, a selection bar, bulk move with per-item
  refusals; Rename, Move to and Delete offered from every view that supports them; a caption
  saying what a drop changes.
- Workspaces: personal groups and pins in the workspace menu, managed under Settings > Workspace.
- Editor: Markdown editing mode with a losses dialog, remote-change warning and one-step undo.
- MCP: remote Streamable HTTP endpoint (`nixctl mcp --listen`), note and item tools, and a
  Settings > MCP tab for tokens and setup.
- Pets: Claude (Anthropic) and OpenRouter providers with per-person API keys; models that cannot
  use tools are labelled; a per-pet "Apply changes without asking by default" setting, also
  offered in note chats.
- Settings > Editor: "Keep notes on this device" toggle; off hides the sync footer.

### Changed

- Sites require `Nix:Sites:Enabled` in addition to a domain and are off everywhere but the
  designated production deployment; every sites route is refused while off.
- `GET /api/v1/me` carries deployment features (sites, MCP endpoint) as display hints.

### Security

- Workspace arrangement, provider keys and MCP token management are interactive-only for
  personal access tokens; provider keys are stored protected and never returned.
