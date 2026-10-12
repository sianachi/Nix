# Brag

Things I have done building [Nix](nix://item/01a130b1-e262-79c3-acfa-89e3ec279537), a self-hosted workspace for notes, tasks, calendars and files. Every number here can be checked against the public repository.

## I built a complete product, alone, in eleven weeks

Between 26 July and 12 October 2026 I made 1,163 commits to Nix's main branch and merged 51 pull requests, as the repository's only contributor. The system spans an ASP.NET Core 10 API, a Node collaboration service, Go background workers, a React 19 web app and a command-line client. It is covered by about 8,300 declared tests: 2,070 in C#, 5,844 in TypeScript and 395 in Go.

## I kept authorisation in the database, not in the token

Core is the only service that decides who may see or change anything, and it filters inside the query, under PostgreSQL row-level security that the schema migrations enable and force table by table, and the runtime database roles cannot bypass it. Browser sign-in is a backend-for-frontend flow with PKCE and an HttpOnly session cookie, and the short-lived access tokens Nix issues carry identity, never roles. Service-to-service routes answer `404` to anyone without the internal secret, so they do not even admit to existing.

## I made editing collaborative and offline-capable

Notes are edited live by several people at once through a dedicated Yjs collaboration service that keeps document history and named versions. The web app installs as an offline-capable app: it caches its own shell, keeps local copies of notes, lets you edit them without a connection and merges the changes when you are back online.

## I shipped website publishing with two production deployment paths

Sites turns any page tree into a static website: Core freezes an immutable build manifest, a separate worker renders and uploads it, and a new build goes live in one step by switching small host manifests, with rollback to earlier builds. Readers are served by an anonymous process with no database, broker or Core access, under a strict Content Security Policy and no cookies, and custom domains are verified by DNS TXT records, with optional Cloudflare automation that never touches records it did not create. It runs both on Docker Compose and on Kubernetes, from seven multi-architecture images that CI publishes for every commit, tagged by full commit SHA.

## I gave it sandboxed plugins and an interface for agents

Plugins are signed WebAssembly components, checked against the Ed25519 key each workspace pins for their publisher and run inside Go workers that hold no database credentials. The `nixctl` command-line client drives the whole workspace from a terminal with JSON output, and its built-in MCP server exposes 93 tools so AI agents can work in Nix through the same permission checks as a person.

