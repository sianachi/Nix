# Collaboration and offline

## Live collaboration

Notes, canvases and sheets are edited live. Several people can work in the same document at once, see each other's cursors and presence, and never overwrite each other's changes. Edits are merged with a CRDT and saved to an append-only log. A connection indicator shows whether your changes have reached the server.

Every edit is checked against your role when it arrives, and a session is re-authorised while it stays open, so removing someone from a workspace takes effect in documents they already have open.

## Version history

Every document has a history built from its edit log.

- Browse revisions. A revision is a run of edits by one person without a long pause.
- See the document as it stood at any revision.
- Restore an earlier state. A restore is added as a new revision, so nothing is lost.
- Name a revision. Named versions are kept permanently, whatever the history retention.

## The installed app

Install Nix from your browser to get an app with its own window, launch shortcuts for New note, Today and Search, a share target and a Markdown file handler. The app shell is cached, so it opens quickly and works without a connection. It remembers where you were and offers right-click menus and keyboard shortcuts like a desktop application.

## Offline notes

The installed app can keep every note you have access to on the device.

- **Download.** Nix downloads the notes in your workspaces in the background and shows how far it has got. Once the download is complete, every note opens without a connection, including ones you have never opened on that device.
- **Edit and create.** Without a connection you can edit notes, create new ones and rename them. Changes are saved on the device straight away and survive closing the app.
- **Sync.** When you reconnect and your session is valid, Nix publishes new notes and sends your edits. Concurrent edits from other people merge rather than conflict, and a retried creation never produces a duplicate note.
- **Honest status.** If storage runs out or a note is too large, Nix says the download is partial rather than claiming everything is ready.

A few things to know:

- Offline notes cover prose notes. Canvases, sheets and file bytes are not downloaded.
- Images and attachments inside a note are not downloaded with its text.
- Password-locked notes are never stored offline, even while unlocked.
- Downloaded notes are not encrypted on the device. Signing out removes them, and the copies on a device cannot learn that your access was revoked until it reconnects.
- Browser storage is not a backup. Your browser or operating system can clear it.

## Properties

- title: Collaboration and offline

