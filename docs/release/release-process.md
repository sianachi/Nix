# Release process

## Versioning

Semantic versioning, `0.x` while the product is pre-1.0. The version is set in every `package.json`
(root, `apps/*`, `packages/*`) and in the MCP server identity; the backend assembly takes the same
number through `Directory.Build.props` when it gains one. Production images are still addressed by
full commit SHA (`deploy/compose/release.sh <sha>`); a version tag names which SHA a release is.

## Cadence

A minor release (`0.x.0`) when a stage of planned work has merged and soaked on production for a
week; a patch (`0.x.y`) for fixes. No fixed calendar.

## Stabilisation criteria

- `main` green: CI frontend, backend and images workflows, including the post-merge backend plan evidence job.
- The deploy smoke (`release-tools smoke`) passes on the target host against the release SHA.
- No open [SEC] finding on surfaces the release touches; migrations reviewed by the backend-data
  specialist.
- Changelog entry written; user-facing help updated in the Nix Docs workspace.

## Changelog

`CHANGELOG.md` follows Keep a Changelog: an `Unreleased` section, then one section per version with
Added, Changed, Fixed, Security. Entries say what a person can now do, not which file changed.

## Upgrade path

- Migrations are additive and run by the `migrator` image before the API starts; a release never
  drops or rewrites a column in the same version that stops reading it.
- Test each migration on a scratch database built from migrations (not the dev DB, which has
  drifted) and on a copy of the production backup when the migration touches an existing table.
- Clients tolerate one version of skew: new nullable fields default; unknown enum tokens read as
  the default.

## Rollback and recovery

Roll back by releasing the previous SHA (`release.sh <previous>`); the ledger in
`NIX_RELEASE_LEDGER` records it. Migrations are forward-only, so a rollback must stay compatible
with the newer schema, which the additive rule guarantees. Data recovery follows
`docs/operations.md` and the backup runbooks.

## Hotfixes

Branch `hotfix/<slug>` from the released SHA, merge to `main` through a PR, release the new SHA,
tag `v0.x.(y+1)`.
