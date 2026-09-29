using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Notifications;
using Nix.Domain.Primitives;
using Nix.Messaging;
using NodaTime;

namespace Nix.Features.Notifications;

/// <summary>Validates a preferences document without trusting a client-chosen zone or time shape.</summary>
public static class PreferencesValidation
{
    private static readonly IDateTimeZoneProvider Zones = DateTimeZoneProviders.Tzdb;

    /// <summary>Gets the document a principal who has never saved preferences reads.</summary>
    public static PreferencesInput Default => new("Etc/UTC", null, null, "09:00", true, true, []);

    /// <summary>Refuses an unknown zone, malformed times, and an over-long mute list.</summary>
    public static bool IsValid(PreferencesInput? input)
    {
        if (input is null || input.TimeZone is null || Zones.GetZoneOrNull(input.TimeZone) is null
            || input.MutedContainerIds is null || input.MutedContainerIds.Count > 200
            || !TryParseTime(input.DueReminderTime, out _))
        {
            return false;
        }

        // Quiet hours are a window: both ends or neither (the database enforces the same).
        return (input.QuietStart is null) == (input.QuietEnd is null)
            && (input.QuietStart is null || TryParseTime(input.QuietStart, out _))
            && (input.QuietEnd is null || TryParseTime(input.QuietEnd, out _));
    }

    /// <summary>Parses "HH:mm" the same way for validation and for storage.</summary>
    public static bool TryParseTime(string text, out TimeOnly value) =>
        TimeOnly.TryParseExact(text, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out value);
}

/// <summary>Reads only the session owner's preferences.</summary>
public sealed class GetPreferencesHandler(IPrincipalPreferencesStore store, INixSessionContextAccessor session) : IQueryHandler<GetPreferences, PrincipalPreferencesResponse>
{
    /// <inheritdoc />
    public async ValueTask<PrincipalPreferencesResponse> HandleAsync(GetPreferences query, CancellationToken cancellationToken)
    {
        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var row = await store.FindAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false);
        return row is null ? ToResponse(0, PreferencesValidation.Default) : ToResponse(row.Revision, new PreferencesInput(
            row.TimeZone, Format(row.QuietStart), Format(row.QuietEnd), Format(row.DueReminderTime) ?? "09:00",
            row.DueReminders, row.HabitReminders, row.MutedContainerIds));
    }

    private static string? Format(TimeOnly? time) => time?.ToString("HH:mm", CultureInfo.InvariantCulture);

    internal static PrincipalPreferencesResponse ToResponse(long revision, PreferencesInput input) =>
        new(revision, input.TimeZone, input.QuietStart, input.QuietEnd, input.DueReminderTime, input.DueReminders, input.HabitReminders, input.MutedContainerIds);
}

/// <summary>Persists preferences using a compare-and-swap revision.</summary>
public sealed class SavePreferencesHandler(IPrincipalPreferencesStore store, INixSessionContextAccessor session) : ICommandHandler<SavePreferences, PrincipalPreferencesResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<PrincipalPreferencesResponse>> HandleAsync(SavePreferences command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (command.ExpectedRevision < 0 || command.ExpectedRevision >= 9007199254740991 || !PreferencesValidation.IsValid(command.Preferences))
        {
            return Result.Failure<PrincipalPreferencesResponse>(new NixError("notifications.invalid_preferences", "Check the time zone, quiet hours, and reminder time, then save again."));
        }

        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var revision = command.ExpectedRevision + 1;

        // Already checked valid by PreferencesValidation.IsValid above; the discard makes that
        // explicit rather than leaving an unchecked out parameter.
        _ = PreferencesValidation.TryParseTime(command.Preferences.DueReminderTime, out var dueReminderTime);
        TimeOnly? quietStart = command.Preferences.QuietStart is { } start && PreferencesValidation.TryParseTime(start, out var parsedStart) ? parsedStart : null;
        TimeOnly? quietEnd = command.Preferences.QuietEnd is { } end && PreferencesValidation.TryParseTime(end, out var parsedEnd) ? parsedEnd : null;

        IReadOnlyList<Guid> mutedContainerIds = [.. command.Preferences.MutedContainerIds.Distinct()];
        var saved = await store.SaveAsync(new PrincipalPreferences
        {
            TenantId = context.TenantId,
            PrincipalId = context.PrincipalId,
            TimeZone = command.Preferences.TimeZone,
            QuietStart = quietStart,
            QuietEnd = quietEnd,
            DueReminderTime = dueReminderTime,
            DueReminders = command.Preferences.DueReminders,
            HabitReminders = command.Preferences.HabitReminders,
            MutedContainerIds = mutedContainerIds,
            Revision = revision,
        }, command.ExpectedRevision, cancellationToken).ConfigureAwait(false);
        return saved ? Result.Success(GetPreferencesHandler.ToResponse(revision, command.Preferences with { MutedContainerIds = mutedContainerIds }))
            : Result.Failure<PrincipalPreferencesResponse>(new NixError("notifications.preferences_conflict", "Preferences changed on another device. Reload before saving."));
    }
}
