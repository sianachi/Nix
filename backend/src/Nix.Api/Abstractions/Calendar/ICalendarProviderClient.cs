namespace Nix.Abstractions.Calendar;

/// <summary>The tokens and identity an authorization-code exchange returned.</summary>
/// <param name="RefreshToken">The long-lived refresh token Core keeps, protected.</param>
/// <param name="AccessToken">A short-lived access token.</param>
/// <param name="ExpiresIn">The access token's lifetime.</param>
/// <param name="Subject">The provider's stable account identity (Google <c>sub</c>, Microsoft <c>tid:oid</c>).</param>
/// <param name="Email">The account's email, for display.</param>
/// <param name="Scopes">The granted scopes, space separated.</param>
public sealed record CalendarTokenGrant(
    string RefreshToken,
    string AccessToken,
    TimeSpan ExpiresIn,
    string Subject,
    string Email,
    string Scopes);

/// <summary>A refreshed access token, and the refresh token the provider rotated to, if it did.</summary>
public sealed record CalendarAccessGrant(string AccessToken, TimeSpan ExpiresIn, string? RotatedRefreshToken);

/// <summary>One calendar of a connected account.</summary>
/// <param name="Id">The provider's calendar id.</param>
/// <param name="Name">Its display name.</param>
/// <param name="Primary">Whether it is the account's default calendar.</param>
/// <param name="ReadOnly">Whether the account cannot write events to it.</param>
public sealed record ExternalCalendar(string Id, string Name, bool Primary, bool ReadOnly);

/// <summary>
/// Core's outbound calls to one calendar provider's token and read-only listing endpoints
/// (ADR-0052, Amendment 1 A3). Refresh tokens and the client secret never leave Core; the worker
/// only ever receives short-lived access tokens.
/// </summary>
/// <remarks>
/// Two real implementations (Google and Microsoft), each pointed at configurable origins so tests
/// and local runs can aim them at a fake server.
/// </remarks>
public interface ICalendarProviderClient
{
    /// <summary>Gets the provider name this client speaks for.</summary>
    public string Provider { get; }

    /// <summary>Redeems an authorization code with its PKCE verifier.</summary>
    /// <exception cref="CalendarProviderUnavailableException">The exchange failed.</exception>
    public Task<CalendarTokenGrant> ExchangeCodeAsync(string code, string verifier, Uri redirectUri, CancellationToken cancellationToken);

    /// <summary>Refreshes an access token.</summary>
    /// <exception cref="CalendarReauthRequiredException">The grant is no longer valid.</exception>
    /// <exception cref="CalendarProviderUnavailableException">The provider could not be reached.</exception>
    public Task<CalendarAccessGrant> RefreshAsync(string refreshToken, CancellationToken cancellationToken);

    /// <summary>Revokes a grant upstream where the provider supports it; best effort.</summary>
    public Task RevokeAsync(string refreshToken, CancellationToken cancellationToken);

    /// <summary>Lists the account's calendars.</summary>
    /// <exception cref="CalendarProviderUnavailableException">The listing failed.</exception>
    public Task<IReadOnlyList<ExternalCalendar>> ListCalendarsAsync(string accessToken, CancellationToken cancellationToken);
}

/// <summary>The provider refused the stored grant; the owner must reconnect.</summary>
public sealed class CalendarReauthRequiredException : Exception
{
    /// <summary>Initializes a new instance.</summary>
    public CalendarReauthRequiredException()
        : base("The calendar provider refused the stored grant.")
    {
    }

    /// <summary>Initializes a new instance with a message.</summary>
    public CalendarReauthRequiredException(string message)
        : base(message)
    {
    }

    /// <summary>Initializes a new instance with a message and cause.</summary>
    public CalendarReauthRequiredException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>The provider could not be reached, timed out, or answered with a server error.</summary>
public sealed class CalendarProviderUnavailableException : Exception
{
    /// <summary>Initializes a new instance.</summary>
    public CalendarProviderUnavailableException()
        : base("The calendar provider is unavailable.")
    {
    }

    /// <summary>Initializes a new instance with a message.</summary>
    public CalendarProviderUnavailableException(string message)
        : base(message)
    {
    }

    /// <summary>Initializes a new instance with a message and cause.</summary>
    public CalendarProviderUnavailableException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
