using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Domain.Primitives;

namespace Nix.Domain.Tenancy;

/// <summary>How a workspace groups its daily notes below the Daily notes root.</summary>
public enum DailyNoteFolders
{
    /// <summary>Every note sits directly under the root.</summary>
    Flat,

    /// <summary>Notes sit under a folder per year.</summary>
    ByYear,

    /// <summary>Notes sit under a folder per year and, inside it, a folder per month.</summary>
    ByMonth,
}

/// <summary>How a new daily note is titled.</summary>
public enum DailyNoteTitleFormat
{
    /// <summary>The canonical date, <c>2026-10-04</c>.</summary>
    Iso,

    /// <summary>The day, month name and year, <c>4 October 2026</c>.</summary>
    LongDate,

    /// <summary>The long form with the weekday in front, <c>Sunday 4 October 2026</c>.</summary>
    WeekdayLongDate,
}

/// <summary>
/// A workspace's daily-note settings: whether the feature is on, where new notes are filed, how
/// they are titled, and the client-side conveniences the server stores on the client's behalf.
/// </summary>
/// <param name="Enabled">Whether daily notes are available in the workspace.</param>
/// <param name="Folders">How new notes are grouped below the Daily notes root.</param>
/// <param name="TitleFormat">How new notes are titled.</param>
/// <param name="Template">Markdown the client inserts into a newly created note; stored, never interpreted.</param>
/// <param name="RolloverHour">The hour, 0 to 6, before which the client still counts it as the previous day; stored, never interpreted.</param>
/// <param name="ShowOnCalendar">Whether the client shows daily notes on the workspace calendar; stored, never interpreted.</param>
/// <remarks>
/// <para>
/// The settings live in one nullable <c>jsonb</c> column on the workspace, and null means "the
/// defaults". The defaults depend on the kind of workspace, because a personal workspace has
/// always had daily notes and a shared one never has: see <see cref="Default"/>.
/// </para>
/// <para>
/// Settings affect only notes created after they change. A note's id is derived from the workspace
/// and its date alone, so an existing note is never moved or retitled to match.
/// </para>
/// </remarks>
public sealed record DailyNoteSettings(
    bool Enabled,
    DailyNoteFolders Folders,
    DailyNoteTitleFormat TitleFormat,
    string Template,
    int RolloverHour,
    bool ShowOnCalendar)
{
    /// <summary>The most characters a template may hold.</summary>
    public const int MaximumTemplateLength = 4000;

    /// <summary>The largest rollover hour.</summary>
    public const int MaximumRolloverHour = 6;

    /// <summary>Stable code for settings that fail validation.</summary>
    public const string InvalidCode = "workspaces.invalid_daily_settings";

    /// <summary>The settings a workspace has until someone saves its own.</summary>
    /// <param name="personal">Whether the workspace is a personal one, where daily notes default on.</param>
    /// <returns>The defaults for that kind of workspace.</returns>
    public static DailyNoteSettings Default(bool personal) =>
        new(personal, DailyNoteFolders.Flat, DailyNoteTitleFormat.Iso, string.Empty, 0, false);

    /// <summary>The wire name of a folder mode.</summary>
    /// <param name="folders">The mode.</param>
    /// <returns><c>flat</c>, <c>by-year</c> or <c>by-month</c>.</returns>
    public static string FoldersName(DailyNoteFolders folders) => folders switch
    {
        DailyNoteFolders.ByYear => "by-year",
        DailyNoteFolders.ByMonth => "by-month",
        _ => "flat",
    };

    /// <summary>The wire name of a title format.</summary>
    /// <param name="format">The format.</param>
    /// <returns><c>iso</c>, <c>long</c> or <c>weekday-long</c>.</returns>
    public static string TitleFormatName(DailyNoteTitleFormat format) => format switch
    {
        DailyNoteTitleFormat.LongDate => "long",
        DailyNoteTitleFormat.WeekdayLongDate => "weekday-long",
        _ => "iso",
    };

    /// <summary>Builds validated settings from the wire values a client sends.</summary>
    /// <param name="enabled">Whether daily notes are on.</param>
    /// <param name="folders">The folder mode name.</param>
    /// <param name="titleFormat">The title format name.</param>
    /// <param name="template">The template, or null for none.</param>
    /// <param name="rolloverHour">The rollover hour.</param>
    /// <param name="showOnCalendar">Whether to show notes on the calendar.</param>
    /// <returns>The settings, or a <see cref="InvalidCode"/> failure naming the first bad field.</returns>
    public static Result<DailyNoteSettings> Create(
        bool enabled,
        string? folders,
        string? titleFormat,
        string? template,
        int rolloverHour,
        bool showOnCalendar)
    {
        if (!TryParseFolders(folders, out var parsedFolders))
        {
            return Invalid("Folders must be flat, by-year or by-month.");
        }

        if (!TryParseTitleFormat(titleFormat, out var parsedFormat))
        {
            return Invalid("Title format must be iso, long or weekday-long.");
        }

        var text = template ?? string.Empty;
        if (text.Length > MaximumTemplateLength)
        {
            return Invalid($"The template may hold at most {MaximumTemplateLength} characters.");
        }

        if (rolloverHour is < 0 or > MaximumRolloverHour)
        {
            return Invalid($"The rollover hour must be from 0 to {MaximumRolloverHour}.");
        }

        return Result.Success(new DailyNoteSettings(
            enabled, parsedFolders, parsedFormat, text, rolloverHour, showOnCalendar));
    }

    /// <summary>
    /// Reads stored settings, falling back to the default for any field that is missing, of the
    /// wrong type, unknown or out of range.
    /// </summary>
    /// <param name="json">The stored document, or null when the workspace has never saved settings.</param>
    /// <param name="personal">Whether the workspace is personal, which decides the defaults.</param>
    /// <returns>The effective settings.</returns>
    /// <remarks>
    /// Tolerant on purpose: the document is written by this build but may be read by another, and a
    /// field a newer build added or a value an older one wrote must degrade to a default rather than
    /// fail the read of the workspace's daily notes.
    /// </remarks>
    public static DailyNoteSettings Read(string? json, bool personal)
    {
        var defaults = Default(personal);
        if (string.IsNullOrWhiteSpace(json))
        {
            return defaults;
        }

        JsonObject? document;
        try
        {
            document = JsonNode.Parse(json) as JsonObject;
        }
        catch (JsonException)
        {
            return defaults;
        }

        if (document is null)
        {
            return defaults;
        }

        var folders = defaults.Folders;
        if (ReadString(document, "folders") is { } foldersText && TryParseFolders(foldersText, out var parsedFolders))
        {
            folders = parsedFolders;
        }

        var format = defaults.TitleFormat;
        if (ReadString(document, "titleFormat") is { } formatText && TryParseTitleFormat(formatText, out var parsedFormat))
        {
            format = parsedFormat;
        }

        var template = defaults.Template;
        if (ReadString(document, "template") is { } templateText && templateText.Length <= MaximumTemplateLength)
        {
            template = templateText;
        }

        var rollover = defaults.RolloverHour;
        if (document["rolloverHour"] is JsonValue hourValue
            && hourValue.TryGetValue<int>(out var hour)
            && hour is >= 0 and <= MaximumRolloverHour)
        {
            rollover = hour;
        }

        return new DailyNoteSettings(
            ReadBool(document, "enabled") ?? defaults.Enabled,
            folders,
            format,
            template,
            rollover,
            ReadBool(document, "showOnCalendar") ?? defaults.ShowOnCalendar);
    }

    /// <summary>Serializes the settings as the stored document.</summary>
    /// <returns>A JSON object holding every field.</returns>
    public string Write() =>
        new JsonObject
        {
            ["enabled"] = Enabled,
            ["folders"] = FoldersName(Folders),
            ["titleFormat"] = TitleFormatName(TitleFormat),
            ["template"] = Template,
            ["rolloverHour"] = RolloverHour,
            ["showOnCalendar"] = ShowOnCalendar,
        }.ToJsonString();

    /// <summary>Formats a new note's title for a day.</summary>
    /// <param name="day">The note's day.</param>
    /// <returns>The title, formatted with the invariant culture so the server's locale never reaches it.</returns>
    public string FormatTitle(DateOnly day) => TitleFormat switch
    {
        DailyNoteTitleFormat.LongDate => day.ToString("d MMMM yyyy", CultureInfo.InvariantCulture),
        DailyNoteTitleFormat.WeekdayLongDate => day.ToString("dddd d MMMM yyyy", CultureInfo.InvariantCulture),
        _ => day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
    };

    /// <summary>The folder keys a new note for a day is filed under, outermost first.</summary>
    /// <param name="day">The note's day.</param>
    /// <returns>Nothing for flat, the year for by-year, and the year then the year-month for by-month.</returns>
    public IReadOnlyList<string> FolderKeys(DateOnly day) => Folders switch
    {
        DailyNoteFolders.ByYear => [day.ToString("yyyy", CultureInfo.InvariantCulture)],
        DailyNoteFolders.ByMonth =>
        [
            day.ToString("yyyy", CultureInfo.InvariantCulture),
            day.ToString("yyyy-MM", CultureInfo.InvariantCulture),
        ],
        _ => [],
    };

    private static bool TryParseFolders(string? text, out DailyNoteFolders folders)
    {
        (var ok, folders) = text switch
        {
            "flat" => (true, DailyNoteFolders.Flat),
            "by-year" => (true, DailyNoteFolders.ByYear),
            "by-month" => (true, DailyNoteFolders.ByMonth),
            _ => (false, DailyNoteFolders.Flat),
        };
        return ok;
    }

    private static bool TryParseTitleFormat(string? text, out DailyNoteTitleFormat format)
    {
        (var ok, format) = text switch
        {
            "iso" => (true, DailyNoteTitleFormat.Iso),
            "long" => (true, DailyNoteTitleFormat.LongDate),
            "weekday-long" => (true, DailyNoteTitleFormat.WeekdayLongDate),
            _ => (false, DailyNoteTitleFormat.Iso),
        };
        return ok;
    }

    private static string? ReadString(JsonObject document, string name) =>
        document[name] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private static bool? ReadBool(JsonObject document, string name) =>
        document[name] is JsonValue value && value.TryGetValue<bool>(out var flag) ? flag : null;

    private static Result<DailyNoteSettings> Invalid(string message) =>
        Result.Failure<DailyNoteSettings>(new NixError(InvalidCode, message));
}
