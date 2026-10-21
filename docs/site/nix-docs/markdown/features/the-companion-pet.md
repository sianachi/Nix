# The companion pet

A Nix pet is a ChatGPT conversation with a small animated character and a controlled set of workspace tools. You can ask it to explain a note, tidy a list or build a whole project structure, all in the same chat. The character is the presentation; what matters is that every change it proposes goes through Nix's own permission checks and, unless you say otherwise, waits for you.

## Setting it up

The pet uses your own ChatGPT account. Connect it once from the pet's settings with a device sign-in; the connection is private to your account. The operator of your Nix instance needs the companion runtime enabled.

You can have up to twelve pet profiles. Each has a name, an appearance (Owl, Neko the cat, Fox, Eye of Ra or Demiurge), a personality (calm, playful, encouraging or concise), a response length and your own instructions. All profiles share the one ChatGPT connection but keep separate conversations for each workspace.

The pet can float over your work, open as a full page, or both. On phones it opens as a page by default.

## What it can do

With workspace access switched on, the pet has 29 tools.

**Reading:** list a container's children, search, read an item, read a note, read a container's fields and views, run a view, list and read templates, and read your calendar for a date range.

**Writing:**

- create notes, append to them, replace a section under a heading or a passage of text;
- rename, move, trash and restore items;
- set properties and complete tasks;
- create structured containers, add fields, add and update views, edit forms and set recurrence;
- create entries in a collection;
- apply templates, save a subtree as a template, and build a blueprint.

A **blueprint** is a whole design (containers, fields, views and sample entries) that the pet proposes in one go. Nix validates it, shows you the tree it will build, and then creates ordinary items through the normal API, reporting each step as done, failed or skipped. The pet looks at your existing templates first and asks a few questions when it needs to.

The pet cannot publish public links, delete anything permanently, remove or retype fields, or delete views.

## Consent and approval

- **Workspace access** starts off for each pet and workspace on a new device. With it off, the pet is just a conversation and cannot see your workspace.
- **Reads** run without asking by default, because they change nothing. You can require approval for reads too. Remember that anything the pet reads is sent to ChatGPT.
- **Writes** show a preview built from the live state of the items involved: the destination, the affected items, and for note edits the changed block before and after. You approve or decline.
- **Apply without asking** lets writes in the current conversation run without a click. It resets when you close or reload the chat.

Some changes always wait for you, even with Apply without asking on: moves, trashing, saving as a template, updating a view, anything that adds an external link, a note edit that would lose formatting, and completing a repeating task. After the pet has read anything from a locked note, every later write in that conversation waits for your approval.

Just before a write runs, Nix checks that the items have not changed since the preview. If they have, it asks you to review again. The pet only reports success after Nix confirms what actually happened.

## Inline writing

Select text in a note to ask the pet for help with it. Inline writing uses a separate, short-lived conversation with no workspace tools, and the result is a suggestion you insert yourself. It is refused inside locked notes.

## Properties

- title: The companion pet

