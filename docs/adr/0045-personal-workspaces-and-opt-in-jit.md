# ADR-0045: Personal workspaces are provisioned by opt-in JIT

- Status: accepted
- Date: 2026-08-30
- Goals: 8.1-8.12

## Context

Nix currently admits only a principal already present in its database. That fail-closed posture is
correct for an unknown issuer, a machine token, and a registered provider whose operator has not
chosen automatic provisioning. It prevents a valid token from silently joining the seeded
administrator workspace.

The product now needs a first-login path for human users and multiple workspaces within the one Nix
tenant. Each newly admitted human needs an isolated place of their own, while shared workspaces need
explicit membership and an owner who cannot be removed accidentally.

Four existing shapes cannot safely carry that behavior unchanged:

- OIDC `sub` is scoped by issuer, but principals are unique only by tenant and subject.
- Zitadel access tokens can contain several signed audiences. Taking the first matching registration
  would let audience order select provisioning policy.
- email is stored as display data without its verification state, so it cannot authorize invitation
  redemption.
- the ordinary request transaction requires a complete, write-once session context, but no principal
  exists yet on the first request.

The MVP-8 plan's old `member` and `admin` role wording is stale. The shipped authorization model and
this decision retain `owner`, `editor`, `commenter`, and `viewer`; new user interfaces offer owner,
editor, and viewer.

## Decision

### Admission stays fail closed

An identity-provider registration has `jit_provisioning_enabled`, false by default, and an optional
bounded HTTPS UserInfo URI. A missing principal is created only when an externally signed token has
validated and its effective provider policy enables JIT. A Core-issued personal-access-token session
never calls UserInfo and never provisions a principal.

Provider resolution returns every registration matching the token's signed issuer and audiences.
All matches must agree on tenant, issuer, JWKS URI and allowed algorithms. After signature validation,
the token's `azp` claim must name one of those exact audience registrations for JIT to be possible.
Effective JIT is the policy of that authorized-party registration and its UserInfo URI must be
non-null. This makes the production web client, rather than a project audience that merely appears in
`aud`, the enforceable interactive-client discriminator. Tokens without `azp`, tokens whose `azp` is
not a matched audience, and tokens authorized to a JIT-disabled project or service client do not
provision. The production JIT registration must prohibit service flows, and tests prove Zitadel
machine tokens cannot provision through it.

The validated access token is sent once to that UserInfo endpoint before a database transaction is
opened. The client uses `ResponseHeadersRead`, refuses redirects, times out after five seconds,
rejects `Content-Length` above 32 KiB and enforces that same 32 KiB limit while streaming when the
length is absent or false. JSON depth is limited to eight; subject, name and email are each limited to
1,024 UTF-8 bytes; no path uses an unbounded string read. The returned `sub` must equal the validated
token subject. Unavailability, timeout, oversize, malformed data, and mismatch return HTTP 503 with
stable code `auth.provisioning_unavailable` and `Retry-After`, without consuming the invalid-token
throttle. Caller cancellation remains cancellation. Tokens, UserInfo bodies and email addresses are
never logged.

### External identity is issuer-qualified

Every externally authenticated identity is `(tenant_id, external_issuer, external_subject)`, not subject alone and
not audience-registration ID. Audience registrations for one issuer are validation policies for the
same identity source; binding a principal to one of them would create duplicate humans when the same
issuer minted a token for another audience.

New external principals always carry the validated issuer. This includes externally authenticated
service identities even though JIT creates humans only. Legacy principals are backfilled only where
their issuer is deterministic. Migration preflight maps deployment-managed external service
identities and aborts with every ambiguous externally authenticated principal for explicit operator
mapping; it never silently deploys a locked-out principal or resolves one by subject alone.
Internal-only principals may keep a null issuer and can never resolve from an external token.

Core-issued personal-access-token JWTs carry the principal ID they were exchanged for and resolve by
`(tenant_id, principal_id)`. They no longer depend on the external subject key. Existing short-lived
Core JWTs may fail closed during rollout and can be exchanged again.

UserInfo email is stored with `email_verified`. The one backend normalizer applies `Trim()`, rejects
empty or oversized values, applies Unicode NFC, then `ToLowerInvariant()`. `email_normalized` is null
whenever email is absent or unverified, enforced by a database check. Invitation input uses the same
normalizer; SQL compares the stored value and never invents a second `lower()` rule. There is no
provider-specific dot or plus folding. Only active human principals with a verified normalized value
participate in automatic invitation matching. Zero or multiple matches leave an invitation pending.

### Provisioning joins the ordinary request transaction

Stable identifiers use these object-specific inputs:

- principal: tenant ID, exact validated issuer string and exact validated subject;
- personal workspace: principal ID;
- Daily Notes root: workspace ID;
- dated Daily Note: workspace ID and canonical `yyyy-MM-dd` route date; and
- each preset object: workspace ID, shipped preset stable key and object-kind suffix.

The derivation hashes a versioned UTF-8 purpose label and each input with SHA-256, takes the first 128
bits, and sets UUID version 8 and RFC variant bits. Every field is framed by a four-byte unsigned
big-endian length. UUID fields use RFC/network byte order, never `Guid.ToByteArray()` order. Issuer
and subject are the exact validated strings without URI re-normalization or Unicode normalization;
other string inputs are ASCII contract values. `DeterministicProvisioningIdTests` is the normative
fixture and contains literal input/output UUID vectors shared with any future implementation.

Because concurrent requests compute the same principal ID, the middleware can establish the final
write-once session context before opening the normal request transaction. Conflict-safe inserts then
create or verify the one principal, one personal workspace, owner membership, Daily Notes root and
shipped presets. Every conflict reads back and verifies the complete identity or workspace tuple. A
unique-identity race that returns a different principal ID rolls back retryably so the next request
can resolve the winner before setting context. A deterministic primary-key collision with a different
identity fails closed as provisioning corruption. Verified-email invitations are transitioned in the
same transaction, and audit rows
are emitted only for rows actually created or transitioned. The original endpoint then executes in
that transaction. Any endpoint failure rolls the entire first-login attempt back and the next request
retries.

The personal workspace uses the existing 90-day retention, ten-minute coalescing and 10 GiB quota
defaults. Its name is `<display name>'s workspace`, falling back to `Personal workspace`. The Daily
Notes root is seeded, while a dated note is created idempotently only when its workspace-scoped daily
route is opened.

### Personal ownership is protected

`workspace.personal_owner_principal_id` distinguishes personal from shared workspaces and has a
tenant-scoped foreign key plus a filtered unique index, guaranteeing at most one personal workspace
per principal. The seeded production workspace becomes the existing administrator's personal
workspace without rename or content movement.

A personal workspace has exactly one protected personal owner. Its collaborators may be editor or
viewer through ordinary controls and cannot replace that owner. The protected owner is the direct
principal membership named by `personal_owner_principal_id`, with role `owner`; no second principal or
group owner may be added, and ordinary mutation SQL cannot change or delete that tuple. This is a
locked store invariant proven by integration tests rather than a deferred database trigger.

A shared workspace may have multiple owners. A recoverable owner is a direct, active human principal
with role `owner`; tenant-administrator reach, groups, service identities and inactive principals do
not satisfy the last-owner invariant. Ordinary APIs do not create group-owner grants. Every
shared-owner removal, demotion or leave locks the workspace row before checking the remaining owners,
so concurrent changes cannot leave it ownerless. Tenant-administrator recovery locks the workspace
and atomically clears `personal_owner_principal_id` while granting an active replacement direct owner;
tenant roles are read from the database, never from token claims.

Invitations are durable history with pending, accepted and revoked states. Revocation changes state
rather than deleting a row. No SMTP delivery is implied: inviters communicate the sign-in address out
of band, and a verified exact email match redeems the invitation.

### The server decides workspace reach and capabilities

Workspace list and detail queries filter reach inside SQL. Inaccessible detail returns the same not
found response as an unknown ID. Responses identify `personal` or `shared` and carry server-decided
`canRename`, `canManageMembers`, and `canLeave`; the client never reconstructs role rules.

Any active human may create a shared workspace and becomes its direct owner. Service identities are
refused even when they otherwise have a tenant role.

Authenticated application routes are workspace-scoped under `/w/:workspaceId/*`. The browser may
remember an opaque last workspace ID, but it resolves and displays a workspace only after an
authenticated, permission-filtered list. Switching aborts workspace requests and clears item and pane
query state so data cannot bleed between workspace caches.

## Consequences

- Enabling JIT is an explicit per-registration production operation and can be rolled back without
  deleting already provisioned principals or workspaces.
- Issuer-qualified identity and principal-ID PATs close collisions that were possible before JIT.
- Deterministic IDs are security-relevant protocol, not an implementation detail; changing their
  derivation requires a new ADR and migration.
- Email can accelerate an explicit invitation but never becomes the principal's identity key.
- Personal workspaces are shareable without making ownership transferable through ordinary member
  controls.
- Provisioning adds no long-lived database transaction around the UserInfo network call.
- The database requires a non-null UserInfo URI whenever JIT is enabled. Production accepts only an
  absolute HTTPS URI on the registered issuer origin. Explicit development and integration
  configuration may allow HTTP only for loopback hosts. Credentials and fragments are always refused.
- SMTP, SCIM, workspace deletion, cross-workspace item movement and multiple Nix organizations remain
  outside this decision.
