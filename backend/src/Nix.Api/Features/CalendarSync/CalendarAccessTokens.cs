using System.Globalization;
using System.Security.Cryptography;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.Calendar;
using Nix.Domain.Calendar;
using Nix.Domain.Notifications;
using Nix.Domain.Tenancy;

namespace Nix.Features.CalendarSync;

/// <summary>How an access-token request ended.</summary>
public enum CalendarAccessStatus
{
    /// <summary>A usable access token was obtained.</summary>
    Ok,

    /// <summary>The grant is dead (or its key lost); the connection is marked and the owner notified.</summary>
    NeedsReauth,

    /// <summary>The connection is gone, revoked, or its provider is no longer configured.</summary>
    ConnectionInactive,

    /// <summary>The provider could not be reached; try again later.</summary>
    ProviderUnavailable,
}

/// <summary>An access-token request's outcome.</summary>
public sealed record CalendarAccessOutcome(CalendarAccessStatus Status, string? AccessToken, DateTimeOffset? ExpiresAt)
{
    internal static CalendarAccessOutcome Failed(CalendarAccessStatus status) => new(status, null, null);
}

/// <summary>
/// Obtains a short-lived provider access token for a connection (contract C1, and the read-only
/// calendar listing), in a transaction of its own.
/// </summary>
/// <remarks>
/// <para>
/// <b>Its own scope and transaction, always.</b> A refresh may rotate the refresh token; storing the
/// rotated one must survive whatever the caller does next, including a worker-execution response
/// of 400 or more, which rolls the execution transaction back (Amendment 1 A6). The same holds for
/// the <c>needs_reauth</c> mark and its notification. The connection row is locked
/// <c>FOR UPDATE</c> in that transaction, which serializes concurrent refreshes of one grant; the
/// caller's own transaction never locks the row, so the two cannot wait on each other.
/// </para>
/// <para>
/// A cached access token is reused while it has more than ten minutes left, so a sync round never
/// starts with a token about to expire.
/// </para>
/// </remarks>
public sealed class CalendarAccessTokens(
    IIsolatedUnitOfWork isolated,
    CalendarProviderClients providers,
    CalendarTokenProtector protector,
    TimeProvider clock)
{
    private static readonly TimeSpan MinimumRemaining = TimeSpan.FromMinutes(10);

    /// <summary>Returns an access token for the connection, refreshing it when the cache is too close to expiry.</summary>
    /// <param name="context">The owner's session, copied into the private scope.</param>
    /// <param name="connectionId">The connection.</param>
    /// <param name="notifyWorkspace">The workspace a reconnect notification points at, if any.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    public Task<CalendarAccessOutcome> AcquireAsync(
        NixSessionContext context, Guid connectionId, WorkspaceId? notifyWorkspace, CancellationToken cancellationToken) =>
        isolated.RunAsync(
            context,
            (provider, token) => AcquireAsync(provider, connectionId, notifyWorkspace, token),
            cancellationToken);

    private async Task<IsolatedOutcome<CalendarAccessOutcome>> AcquireAsync(
        IServiceProvider provider, Guid connectionId, WorkspaceId? notifyWorkspace, CancellationToken cancellationToken)
    {
        var store = provider.GetRequiredService<ICalendarSyncStore>();
        var connection = await store.LockConnectionAsync(connectionId, cancellationToken).ConfigureAwait(false);
        if (connection is null || connection.Status == "revoked")
        {
            return Keep(CalendarAccessOutcome.Failed(CalendarAccessStatus.ConnectionInactive), commit: false);
        }

        if (connection.Status == "needs_reauth")
        {
            return Keep(CalendarAccessOutcome.Failed(CalendarAccessStatus.NeedsReauth), commit: false);
        }

        var now = clock.GetUtcNow();
        if (connection.AccessTokenProtected is { } cached
            && connection.AccessTokenExpiresAt is { } cachedExpiry
            && cachedExpiry - now > MinimumRemaining)
        {
            try
            {
                return Keep(new CalendarAccessOutcome(CalendarAccessStatus.Ok, protector.UnprotectAccessToken(cached), cachedExpiry), commit: false);
            }
            catch (CryptographicException)
            {
                // A lost key only costs the cache; the refresh below decides.
            }
        }

        if (providers.For(connection.Provider) is not { } client
            || connection.RefreshTokenProtected is not { } protectedRefresh)
        {
            return Keep(CalendarAccessOutcome.Failed(CalendarAccessStatus.ConnectionInactive), commit: false);
        }

        string refreshToken;
        try
        {
            refreshToken = protector.UnprotectRefreshToken(protectedRefresh);
        }
        catch (CryptographicException)
        {
            return await RecordReauthAsync(provider, store, connection, "data_protection_key_lost", notifyWorkspace, cancellationToken)
                .ConfigureAwait(false);
        }

        CalendarAccessGrant grant;
        try
        {
            grant = await client.RefreshAsync(refreshToken, cancellationToken).ConfigureAwait(false);
        }
        catch (CalendarReauthRequiredException)
        {
            return await RecordReauthAsync(provider, store, connection, "grant_refused", notifyWorkspace, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (CalendarProviderUnavailableException)
        {
            return Keep(CalendarAccessOutcome.Failed(CalendarAccessStatus.ProviderUnavailable), commit: false);
        }

        var expiresAt = clock.GetUtcNow() + grant.ExpiresIn;
        await store.StoreTokensAsync(
            connection.Id,
            grant.RotatedRefreshToken is { } rotated ? protector.ProtectRefreshToken(rotated) : null,
            protector.ProtectAccessToken(grant.AccessToken),
            expiresAt,
            clock.GetUtcNow(),
            cancellationToken).ConfigureAwait(false);
        return Keep(new CalendarAccessOutcome(CalendarAccessStatus.Ok, grant.AccessToken, expiresAt), commit: true);
    }

    /// <summary>
    /// Marks the connection <c>needs_reauth</c> and, only on that transition, notifies its owner
    /// once - both committed in this private transaction.
    /// </summary>
    private async Task<IsolatedOutcome<CalendarAccessOutcome>> RecordReauthAsync(
        IServiceProvider provider,
        ICalendarSyncStore store,
        CalendarConnection connection,
        string reason,
        WorkspaceId? notifyWorkspace,
        CancellationToken cancellationToken)
    {
        var now = clock.GetUtcNow();
        if (await store.MarkNeedsReauthAsync(connection.Id, reason, now, cancellationToken).ConfigureAwait(false))
        {
            var account = connection.Provider == "google" ? "Google Calendar" : "Outlook";
            await provider.GetRequiredService<INotificationWriter>().CreateAsync(
                connection.PrincipalId,
                NotificationKind.Calendar,
                "Reconnect your calendar",
                $"Nix can no longer sync your {account} account. Reconnect it in Settings.",
                null,
                notifyWorkspace,
                $"calendar:reauth:{connection.Id:D}:{now.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture)}",
                cancellationToken).ConfigureAwait(false);
        }

        return Keep(CalendarAccessOutcome.Failed(CalendarAccessStatus.NeedsReauth), commit: true);
    }

    private static IsolatedOutcome<CalendarAccessOutcome> Keep(CalendarAccessOutcome outcome, bool commit) => new(outcome, commit);
}
