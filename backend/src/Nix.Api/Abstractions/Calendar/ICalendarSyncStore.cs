using Nix.Domain.Calendar;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Calendar;

#pragma warning disable CA1819 // Justification: protected tokens are opaque bytea values handed straight to storage.
/// <summary>What a connection upsert stores after a successful authorization-code exchange.</summary>
/// <param name="Provider">The provider name.</param>
/// <param name="AccountSubject">The provider's stable account identity.</param>
/// <param name="AccountEmail">The account's email, for display.</param>
/// <param name="Scopes">The granted scopes, space separated.</param>
/// <param name="RefreshTokenProtected">The Data Protection-protected refresh token.</param>
/// <param name="AccessTokenProtected">The protected access token from the same exchange.</param>
/// <param name="AccessTokenExpiresAt">When that access token expires.</param>
public sealed record CalendarConnectionGrant(
    string Provider,
    string AccountSubject,
    string AccountEmail,
    string Scopes,
    byte[] RefreshTokenProtected,
    byte[] AccessTokenProtected,
    DateTimeOffset AccessTokenExpiresAt);
#pragma warning restore CA1819

/// <summary>How a link insert ended.</summary>
public enum CalendarLinkWrite
{
    /// <summary>The link was stored.</summary>
    Created,

    /// <summary>The container or the external calendar is already linked.</summary>
    Exists,

    /// <summary>The container was purged while the link was being made.</summary>
    ContainerMissing,
}

/// <summary>
/// A map write lost a race for one of the link's pairing indexes (one row per item, one per
/// external event). The write's transaction is aborted; the round that made it should stop.
/// </summary>
public sealed class CalendarPairingConflictException : InvalidOperationException
{
    public CalendarPairingConflictException()
        : base("Another map row of the link already pairs this item or external event.")
    {
    }

    public CalendarPairingConflictException(string message)
        : base(message)
    {
    }

    public CalendarPairingConflictException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>A mirrored item's current state beside its map row, as the push selection reads it.</summary>
/// <param name="Map">The map row, or <see langword="null"/> for an item never pushed.</param>
/// <param name="ItemId">The item.</param>
/// <param name="Properties">The item's property bag, or <see langword="null"/> when the item is gone.</param>
/// <param name="LastModifiedAt">The item's <c>last_modified_at</c>, or <see langword="null"/> when gone.</param>
/// <param name="Live">Whether the item is active and still a child of the link's container.</param>
public sealed record CalendarPushCandidate(
    CalendarEventMap? Map,
    Guid ItemId,
    string? Properties,
    DateTimeOffset? LastModifiedAt,
    bool Live);

/// <summary>A live mapped event's start, read for a full resync's reconciliation.</summary>
/// <param name="Map">The live map row.</param>
/// <param name="Start">The item's stored <c>start</c> text, or <see langword="null"/>.</param>
/// <param name="ItemActive">
/// Whether the item is still an active, non-template child of the link's container in the link's
/// workspace: only such an item may be trashed by the reconciliation.
/// </param>
public sealed record CalendarMappedStart(CalendarEventMap Map, string? Start, bool ItemActive);

/// <summary>A link's live mapped events, and whether there were more than the read was allowed.</summary>
/// <param name="Rows">The rows read, in map id order.</param>
/// <param name="Truncated">Whether the link has more live mapped events than were read.</param>
public sealed record CalendarMappedStarts(IReadOnlyList<CalendarMappedStart> Rows, bool Truncated);

/// <summary>
/// The calendar sync tables, row-level-security-scoped to the session principal: every call runs
/// in a session whose principal is the connection and link owner (a request, a worker execution
/// bound to the owner's job, or the dispatcher's per-trigger session).
/// </summary>
public interface ICalendarSyncStore
{
    /// <summary>The session principal's personal workspace, if they have one.</summary>
    public Task<WorkspaceId?> PersonalWorkspaceAsync(CancellationToken cancellationToken);

    /// <summary>The owner's connections, newest first.</summary>
    public Task<IReadOnlyList<CalendarConnection>> ListConnectionsAsync(CancellationToken cancellationToken);

    /// <summary>One of the owner's connections.</summary>
    public Task<CalendarConnection?> GetConnectionAsync(Guid connectionId, CancellationToken cancellationToken);

    /// <summary>One of the owner's connections, locked <c>FOR UPDATE</c> until the transaction ends.</summary>
    public Task<CalendarConnection?> LockConnectionAsync(Guid connectionId, CancellationToken cancellationToken);

    /// <summary>
    /// Creates the connection, or updates the one this principal already has for the same
    /// provider account: status <c>active</c>, fresh tokens, cleared error. Returns its id.
    /// </summary>
    public Task<Guid> UpsertConnectionAsync(
        TenantId tenantId, PrincipalId principalId, CalendarConnectionGrant grant, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Stores a refreshed access token and, when the provider rotated it, the new refresh token.</summary>
    public Task StoreTokensAsync(
        Guid connectionId, byte[]? rotatedRefreshTokenProtected, byte[] accessTokenProtected, DateTimeOffset accessTokenExpiresAt,
        DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Moves an active connection to <c>needs_reauth</c>; returns whether this call made that transition.</summary>
    public Task<bool> MarkNeedsReauthAsync(Guid connectionId, string reason, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Revokes a connection: tokens nulled, its links stopped and their pending triggers cancelled.</summary>
    public Task<bool> RevokeConnectionAsync(Guid connectionId, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>The owner's links, optionally in one workspace.</summary>
    public Task<IReadOnlyList<CalendarLink>> ListLinksAsync(WorkspaceId? workspaceId, CancellationToken cancellationToken);

    /// <summary>One of the owner's links.</summary>
    public Task<CalendarLink?> GetLinkAsync(Guid linkId, CancellationToken cancellationToken);

    /// <summary>
    /// One of the owner's links, locked <c>FOR UPDATE</c> until the transaction ends, so deciding
    /// whether a round is running and enqueueing one is atomic for that link.
    /// </summary>
    public Task<CalendarLink?> LockLinkAsync(Guid linkId, CancellationToken cancellationToken);

    /// <summary>
    /// Stores a new link, refusing a second link of the same container or calendar, and reporting a
    /// container purged meanwhile without aborting the caller's transaction.
    /// </summary>
    public Task<CalendarLinkWrite> InsertLinkAsync(CalendarLink link, CancellationToken cancellationToken);

    /// <summary>Replaces a link's editable fields if its revision still matches; returns the new row or <see langword="null"/>.</summary>
    public Task<CalendarLink?> UpdateLinkAsync(
        Guid linkId, int expectedRevision, string name, string direction, string status, short windowPastDays, short windowFutureDays,
        DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Deletes a link, its map and its log, and cancels its pending triggers.</summary>
    public Task<bool> DeleteLinkAsync(Guid linkId, CancellationToken cancellationToken);

    /// <summary>Records the job last enqueued for a link.</summary>
    public Task SetLastJobAsync(Guid linkId, Guid jobId, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Records a link failure, optionally moving its status.</summary>
    public Task SetLinkErrorAsync(Guid linkId, string? status, string reason, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Stores a completed round's cursor and window, clearing the error and reviving an errored link.</summary>
    public Task StoreCursorAsync(
        Guid linkId, string? cursor, DateTimeOffset windowStart, DateTimeOffset windowEnd, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>
    /// Inserts a <c>calendar.dirty</c> trigger for this minute (firing at the next minute's start)
    /// unless one is already recorded for it.
    /// </summary>
    public Task EnqueueDirtyAsync(CalendarLink link, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Appends log rows.</summary>
    public Task AppendLogAsync(IReadOnlyCollection<CalendarSyncLogEntry> entries, CancellationToken cancellationToken);

    /// <summary>One page of a link's log, newest first, strictly before the cursor when given.</summary>
    public Task<IReadOnlyList<CalendarSyncLogEntry>> ReadLogAsync(
        Guid linkId, DateTimeOffset? beforeAt, Guid? beforeId, int limit, CancellationToken cancellationToken);

    /// <summary>The map row of one external event of a link, live or a tombstone.</summary>
    public Task<CalendarEventMap?> FindMapByExternalAsync(Guid linkId, string externalEventId, CancellationToken cancellationToken);

    /// <summary>The map rows of these external events of a link, live or tombstones.</summary>
    public Task<IReadOnlyList<CalendarEventMap>> FindMapsByExternalAsync(
        Guid linkId, IReadOnlyCollection<string> externalEventIds, CancellationToken cancellationToken);

    /// <summary>
    /// The map row of an item this link handed out as a create that was never confirmed (no external
    /// id yet, still <c>push_op = 'create'</c>), the row a stamped event adopts after a lost C4.
    /// </summary>
    public Task<CalendarEventMap?> FindUnconfirmedCreateAsync(Guid linkId, Guid itemId, CancellationToken cancellationToken);

    /// <summary>The map rows of these items of a link.</summary>
    public Task<IReadOnlyList<CalendarEventMap>> FindMapsByItemsAsync(Guid linkId, IReadOnlyCollection<Guid> itemIds, CancellationToken cancellationToken);

    /// <summary>
    /// Inserts or replaces one map row by its id. Returns <see langword="false"/>, writing nothing,
    /// when another row of the link already pairs the same item or the same external event; throws
    /// <see cref="CalendarPairingConflictException"/> if a concurrent write wins that race anyway.
    /// </summary>
    public Task<bool> SaveMapAsync(CalendarEventMap row, CancellationToken cancellationToken);

    /// <summary>
    /// The candidates for one push page, in item-modified order: unmapped (or unconfirmed, or
    /// tombstoned) children of the container with a start, mapped children modified since their
    /// last sync, and live mapped rows whose item is gone, inactive or moved away.
    /// </summary>
    public Task<IReadOnlyList<CalendarPushCandidate>> SelectPushCandidatesAsync(
        CalendarLink link, int limit, CancellationToken cancellationToken);

    /// <summary>
    /// Sets (or, with <see langword="null"/>, clears) the transaction-local
    /// <c>nix.calendar_sync_link</c> marker the dirty feed skips on, so the pull path's own item
    /// writes never echo back as pushes.
    /// </summary>
    public Task SetSyncMarkerAsync(Guid? linkId, CancellationToken cancellationToken);

    /// <summary>
    /// Up to <paramref name="limit"/> live mapped events of a link that have an external id, with
    /// their item's start and whether the item is still an active child of the link's container.
    /// </summary>
    public Task<CalendarMappedStarts> ListMappedStartsAsync(CalendarLink link, int limit, CancellationToken cancellationToken);
}

/// <summary>An active link, found across tenants for the planner.</summary>
public sealed record ActiveCalendarLink(
    TenantId TenantId,
    Guid LinkId,
    WorkspaceId WorkspaceId,
    PrincipalId PrincipalId,
    Guid ContainerItemId);

/// <summary>
/// Cross-tenant discovery of active links for the planned source and bounded retention, backed by
/// the SECURITY DEFINER functions in <c>CalendarSyncSecuritySql</c>.
/// </summary>
public interface ICalendarLinkFinder
{
    /// <summary>One keyset page of active links on active connections, in id order.</summary>
    public Task<IReadOnlyList<ActiveCalendarLink>> FindActiveAsync(int limit, Guid afterId, CancellationToken cancellationToken);
}
