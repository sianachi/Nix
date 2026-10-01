using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Calendar;

#pragma warning disable CA1819 // Justification: EF Core's PostgreSQL bytea provider requires byte[] storage for protected tokens and 32-byte hashes.

/// <summary>
/// One principal's OAuth grant to one external calendar account (ADR-0052, Amendment 1 A2).
/// Owner-private: principal-scoped row security, and the tokens never leave Core.
/// </summary>
public sealed record CalendarConnection
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the connection's identity.</summary>
    public required Guid Id { get; init; }

    /// <summary>Gets the principal who granted it and whom every sync over it acts as.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>Gets the provider: <c>google</c> or <c>microsoft</c>.</summary>
    public required string Provider { get; init; }

    /// <summary>Gets the provider's stable account identity, so reconnecting updates this row.</summary>
    public required string AccountSubject { get; init; }

    /// <summary>Gets the account's email, for display only.</summary>
    public required string AccountEmail { get; init; }

    /// <summary>Gets <c>active</c>, <c>needs_reauth</c> or <c>revoked</c>.</summary>
    public required string Status { get; init; }

    /// <summary>Gets the Data Protection-protected refresh token, or <see langword="null"/> once revoked.</summary>
    public byte[]? RefreshTokenProtected { get; init; }

    /// <summary>Gets the protected cached access token, if any.</summary>
    public byte[]? AccessTokenProtected { get; init; }

    /// <summary>Gets when the cached access token expires.</summary>
    public DateTimeOffset? AccessTokenExpiresAt { get; init; }

    /// <summary>Gets the granted scopes, space separated.</summary>
    public required string Scopes { get; init; }

    /// <summary>Gets a short, non-user-text reason for the last failure.</summary>
    public string? LastError { get; init; }

    /// <summary>Gets when it was first connected.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets when it last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>
/// A binding between one external calendar and one Nix container whose children are its events.
/// </summary>
public sealed record CalendarLink
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the link's identity.</summary>
    public required Guid Id { get; init; }

    /// <summary>Gets the owner: the connection's principal, whom the sync acts as.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>Gets the connection whose token reaches the external calendar.</summary>
    public required Guid ConnectionId { get; init; }

    /// <summary>Gets the workspace the container lives in.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets the container whose children are the calendar's events.</summary>
    public required ItemId ContainerItemId { get; init; }

    /// <summary>Gets the provider's calendar id.</summary>
    public required string ExternalCalendarId { get; init; }

    /// <summary>Gets what the owner calls it.</summary>
    public required string Name { get; init; }

    /// <summary>Gets <c>two_way</c> or <c>import_only</c>.</summary>
    public required string Direction { get; init; }

    /// <summary>Gets how many days before today the pull window reaches.</summary>
    public required short WindowPastDays { get; init; }

    /// <summary>Gets how many days after today the pull window reaches.</summary>
    public required short WindowFutureDays { get; init; }

    /// <summary>Gets the provider's incremental cursor (a Google syncToken or a Graph deltaLink).</summary>
    public string? SyncCursor { get; init; }

    /// <summary>Gets the window start the cursor was taken over.</summary>
    public DateTimeOffset? CursorWindowStart { get; init; }

    /// <summary>Gets the window end the cursor was taken over.</summary>
    public DateTimeOffset? CursorWindowEnd { get; init; }

    /// <summary>Gets <c>active</c>, <c>paused</c>, <c>stopped</c> or <c>error</c>.</summary>
    public required string Status { get; init; }

    /// <summary>Gets when a round last completed.</summary>
    public DateTimeOffset? LastSyncedAt { get; init; }

    /// <summary>Gets a short reason for the last failure.</summary>
    public string? LastError { get; init; }

    /// <summary>Gets the last <c>calendar.sync</c> job enqueued for it, for coalescing.</summary>
    public Guid? LastJobId { get; init; }

    /// <summary>Gets the compare-and-set revision.</summary>
    public required int Revision { get; init; }

    /// <summary>Gets when it was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets when it last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>
/// Which item mirrors which external event, and what each side looked like at the last sync.
/// </summary>
/// <remarks>
/// <see cref="ItemId"/> carries no foreign key on purpose: a purged item must still yield an
/// upstream delete.
/// </remarks>
public sealed record CalendarEventMap
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the row's identity.</summary>
    public required Guid Id { get; init; }

    /// <summary>Gets the link it belongs to.</summary>
    public required Guid LinkId { get; init; }

    /// <summary>Gets the link owner, carried for row-level security.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>Gets the mirrored item.</summary>
    public required Guid ItemId { get; init; }

    /// <summary>Gets the provider's event id, or <see langword="null"/> while a create is unconfirmed.</summary>
    public string? ExternalEventId { get; init; }

    /// <summary>Gets the provider's etag or changeKey at the last sync.</summary>
    public string? ExternalVersion { get; init; }

    /// <summary>Gets the provider's last-modified instant at the last sync.</summary>
    public DateTimeOffset? ExternalUpdatedAt { get; init; }

    /// <summary>Gets the item's <c>last_modified_at</c> at the last sync.</summary>
    public DateTimeOffset? NixVersion { get; init; }

    /// <summary>Gets the SHA-256 of the synced fields at the last sync.</summary>
    public byte[]? LastSyncedHash { get; init; }

    /// <summary>Gets the item's <c>last_modified_at</c> as last handed to the worker to push.</summary>
    public DateTimeOffset? PushNixVersion { get; init; }

    /// <summary>Gets the hash of the fields last handed to the worker to push.</summary>
    public byte[]? PushHash { get; init; }

    /// <summary>Gets the operation last handed to the worker: <c>create</c>, <c>update</c> or <c>delete</c>.</summary>
    public string? PushOp { get; init; }

    /// <summary>Gets how many pushes in a row have failed.</summary>
    public required short PushFailures { get; init; }

    /// <summary>Gets the worker execution that last saw this event in a full resync.</summary>
    public string? SeenExecution { get; init; }

    /// <summary>Gets when the pair stopped existing (a tombstone), if it did.</summary>
    public DateTimeOffset? DeletedAt { get; init; }

    /// <summary>Gets when it was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets when it last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>One visible sync log row, retained 30 days.</summary>
public sealed record CalendarSyncLogEntry
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the row's identity.</summary>
    public required Guid Id { get; init; }

    /// <summary>Gets the link it belongs to.</summary>
    public required Guid LinkId { get; init; }

    /// <summary>Gets the link owner, carried for row-level security.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>Gets when it happened.</summary>
    public required DateTimeOffset At { get; init; }

    /// <summary>Gets <c>pull</c> or <c>push</c>.</summary>
    public required string Direction { get; init; }

    /// <summary>Gets <c>created</c>, <c>updated</c>, <c>deleted</c>, <c>conflict</c>, <c>skipped</c> or <c>error</c>.</summary>
    public required string Action { get; init; }

    /// <summary>Gets the item concerned, if any.</summary>
    public Guid? ItemId { get; init; }

    /// <summary>Gets the external event concerned, if any.</summary>
    public string? ExternalEventId { get; init; }

    /// <summary>Gets a short, bounded description.</summary>
    public required string Detail { get; init; }
}
#pragma warning restore CA1819
