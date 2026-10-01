using System.Collections.Immutable;
using System.Text.Json.Serialization;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Views;

namespace Nix.Features.CalendarSync;

/// <summary>Whether this deployment can connect a provider.</summary>
public sealed record CalendarProviderResponse(string Provider, bool Available);

/// <summary>One of the caller's calendar connections. Tokens are never returned.</summary>
public sealed record CalendarConnectionResponse(
    Guid Id,
    string Provider,
    string AccountEmail,
    string Status,
    IReadOnlyList<string> Scopes,
    DateTimeOffset CreatedAt,
    string? LastError);

/// <summary>The providers and the caller's connections.</summary>
public sealed record CalendarConnectionsResponse(
    IReadOnlyList<CalendarProviderResponse> Providers,
    IReadOnlyList<CalendarConnectionResponse> Connections);

/// <summary>Starts connecting a provider account.</summary>
/// <param name="ReturnTo">A same-origin path to come back to; anything else falls back to Settings.</param>
public sealed record AuthorizeCalendarRequest(string? ReturnTo);

/// <summary>The provider page the browser navigates to.</summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1056:URI-like properties should not be strings", Justification = "The wire contract carries the URL as a plain string.")]
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1054:URI-like parameters should not be strings", Justification = "The wire contract carries the URL as a plain string.")]
public sealed record AuthorizeCalendarResponse(string AuthorizationUrl);

/// <summary>One calendar of a connected account.</summary>
public sealed record ExternalCalendarResponse(string Id, string Name, bool Primary, bool ReadOnly);

/// <summary>A connected account's calendars.</summary>
public sealed record ExternalCalendarsResponse(IReadOnlyList<ExternalCalendarResponse> Calendars);

/// <summary>One calendar link.</summary>
public sealed record CalendarLinkResponse(
    Guid Id,
    Guid ConnectionId,
    string Provider,
    Guid WorkspaceId,
    Guid ContainerItemId,
    string ExternalCalendarId,
    string Name,
    string Direction,
    int WindowPastDays,
    int WindowFutureDays,
    string Status,
    DateTimeOffset? LastSyncedAt,
    string? LastError,
    int Revision);

/// <summary>The caller's links.</summary>
public sealed record CalendarLinksResponse(IReadOnlyList<CalendarLinkResponse> Links);

/// <summary>A new container for a link.</summary>
/// <param name="ParentId">Where to create it, or null for the workspace root.</param>
/// <param name="Title">What to call it.</param>
public sealed record CalendarLinkNewContainer(Guid? ParentId, string Title);

/// <summary>Exactly one of an existing container or a new one.</summary>
public sealed record CalendarLinkContainerRequest(Guid? ItemId, CalendarLinkNewContainer? Create);

/// <summary>Links an external calendar to a container.</summary>
public sealed record CreateCalendarLinkRequest(
    Guid ConnectionId,
    string ExternalCalendarId,
    Guid WorkspaceId,
    CalendarLinkContainerRequest Container,
    string Direction,
    int? WindowPastDays,
    int? WindowFutureDays);

/// <summary>Changes a link at the revision the caller read.</summary>
public sealed record UpdateCalendarLinkRequest(
    int Revision,
    string? Name,
    string? Direction,
    string? Status,
    int? WindowPastDays,
    int? WindowFutureDays);

/// <summary>Asks for a sync round now.</summary>
/// <param name="Full">Whether to drop the cursor and reconcile the whole window.</param>
public sealed record SyncCalendarLinkRequest(bool? Full);

/// <summary>The job the round runs as.</summary>
public sealed record SyncCalendarLinkResponse(Guid JobId);

/// <summary>One visible log row.</summary>
public sealed record CalendarSyncLogEntryResponse(
    Guid Id,
    DateTimeOffset At,
    string Direction,
    string Action,
    Guid? ItemId,
    string? ExternalId,
    string Detail);

/// <summary>One page of a link's log, newest first.</summary>
public sealed record CalendarSyncLogPageResponse(IReadOnlyList<CalendarSyncLogEntryResponse> Entries, string? NextCursor);

/// <summary>The refusals the calendar sync routes give, with their stable codes.</summary>
public static class CalendarSyncErrors
{
    /// <summary>The provider is not configured in this deployment, or could not be reached.</summary>
    public const string ProviderUnavailableCode = "calendar.provider_unavailable";

    /// <summary>No such connection is visible.</summary>
    public const string ConnectionNotFoundCode = "calendar.connection_not_found";

    /// <summary>The connection's grant is dead; the owner must reconnect.</summary>
    public const string NeedsReauthCode = "calendar.needs_reauth";

    /// <summary>No such link is visible.</summary>
    public const string LinkNotFoundCode = "calendar.link_not_found";

    /// <summary>The external calendar is not on the account.</summary>
    public const string CalendarNotFoundCode = "calendar.calendar_not_found";

    /// <summary>The workspace or container is not visible or not writable.</summary>
    public const string ContainerNotFoundCode = "calendar.container_not_found";

    /// <summary>The container already declares a sync key with another type.</summary>
    public const string ContainerSchemaConflictCode = "calendar.container_schema_conflict";

    /// <summary>The container or calendar is already linked.</summary>
    public const string LinkExistsCode = "calendar.link_exists";

    /// <summary>The link changed since the caller read it.</summary>
    public const string ConflictCode = "calendar.conflict";

    /// <summary>The link is not in a state that can sync.</summary>
    public const string LinkInactiveCode = "calendar.link_inactive";

    /// <summary>The request was malformed.</summary>
    public const string InvalidCode = "calendar.invalid";

    /// <summary>The message that marks "not configured here" (404) apart from "unreachable" (503).</summary>
    internal const string NotConfiguredMessage = "This calendar provider is not configured.";

    internal static NixError ProviderUnavailable(string message = "This calendar provider is not available right now.") =>
        new(ProviderUnavailableCode, message);

    internal static NixError ConnectionNotFound { get; } = new(ConnectionNotFoundCode, "No calendar connection by that id is visible.");

    internal static NixError NeedsReauth { get; } = new(NeedsReauthCode, "This calendar account must be reconnected in Settings.");

    internal static NixError LinkNotFound { get; } = new(LinkNotFoundCode, "No calendar link by that id is visible.");

    internal static NixError CalendarNotFound { get; } = new(CalendarNotFoundCode, "That calendar is not on the connected account.");

    internal static NixError ContainerNotFound { get; } = new(ContainerNotFoundCode, "The workspace or container is not visible or cannot be changed.");

    internal static NixError LinkExists { get; } = new(LinkExistsCode, "That container or calendar is already linked.");

    internal static NixError Conflict { get; } = new(ConflictCode, "This link changed since you opened it. Reload it before saving.");

    internal static NixError LinkInactive { get; } = new(LinkInactiveCode, "This link is paused or stopped.");

    internal static NixError ContainerSchemaConflict(string key) =>
        new(ContainerSchemaConflictCode, $"The container already has a '{key}' field of another type.");

    internal static NixError Invalid(string message) => new(InvalidCode, message);
}

/// <summary>
/// The schema a synced calendar's container declares (ADR-0052): <c>start</c> and <c>end</c> as
/// <c>datetime</c>, <c>location</c> and <c>details</c> as text, and a calendar view placed by
/// <c>start</c> with end <c>end</c>. The structure-spec recipe in D4 mirrors it.
/// </summary>
public static class CalendarContainerSchema
{
    /// <summary>The start key.</summary>
    public const string StartKey = "start";

    /// <summary>The end key.</summary>
    public const string EndKey = "end";

    /// <summary>The location key.</summary>
    public const string LocationKey = "location";

    /// <summary>The details key.</summary>
    public const string DetailsKey = "details";

    /// <summary>The calendar view's id.</summary>
    public const string ViewId = "synced-calendar";

    /// <summary>The declared properties.</summary>
    public static ImmutableArray<PropertyDefinition> Properties { get; } =
    [
        new(StartKey, "Start", PropertyType.DateTime, [], false),
        new(EndKey, "End", PropertyType.DateTime, [], false),
        new(LocationKey, "Location", PropertyType.Text, [], false),
        new(DetailsKey, "Details", PropertyType.Text, [], false),
    ];

    /// <summary>The schema a new container is created with.</summary>
    public static PropertySchema Schema { get; } = new() { Properties = Properties, Inherit = true };

    /// <summary>The calendar view placed by start with end end.</summary>
    public static ViewDefinition CalendarView { get; } = new(
        ViewId,
        "Calendar",
        ViewKind.Calendar,
        ["title", StartKey, EndKey, LocationKey],
        null,
        [],
        StartKey,
        null,
        false,
        Mode: "month",
        EndDateProperty: EndKey);
}

/// <summary>The public calendar sync routes' JSON (never shared with the calendar range feature's context).</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(CalendarConnectionsResponse))]
[JsonSerializable(typeof(AuthorizeCalendarRequest))]
[JsonSerializable(typeof(AuthorizeCalendarResponse))]
[JsonSerializable(typeof(ExternalCalendarsResponse))]
[JsonSerializable(typeof(CalendarLinkResponse))]
[JsonSerializable(typeof(CalendarLinksResponse))]
[JsonSerializable(typeof(CreateCalendarLinkRequest))]
[JsonSerializable(typeof(UpdateCalendarLinkRequest))]
[JsonSerializable(typeof(SyncCalendarLinkRequest))]
[JsonSerializable(typeof(SyncCalendarLinkResponse))]
[JsonSerializable(typeof(CalendarSyncLogPageResponse))]
internal sealed partial class CalendarSyncJsonContext : JsonSerializerContext;
