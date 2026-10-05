using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Nix.Domain.Calendar;

/// <summary>Which side's version of an event survives when both may have changed.</summary>
public enum CalendarSyncWinner
{
    /// <summary>The provider's event is applied to the item.</summary>
    Provider,

    /// <summary>The item is kept and will be pushed over the provider's event.</summary>
    Nix,
}

/// <summary>Which trigger source a calendar trigger key belongs to.</summary>
public enum CalendarTriggerKind
{
    /// <summary>The five-minute planned poll (<c>calendar.sync</c>).</summary>
    Planned,

    /// <summary>A write in a linked container (<c>calendar.dirty</c>).</summary>
    Dirty,
}

/// <summary>A parsed calendar trigger dedupe key.</summary>
/// <param name="Kind">The source the key belongs to.</param>
/// <param name="LinkId">The link it syncs.</param>
/// <param name="Minute">The UTC minute it names: the planned slot, or the minute of the write.</param>
public readonly record struct CalendarTriggerKey(CalendarTriggerKind Kind, Guid LinkId, DateTimeOffset Minute);

/// <summary>
/// The pure rules of two-way calendar sync (ADR-0052 and its Amendment 1): nothing here reads a
/// database or a clock.
/// </summary>
public static class CalendarSyncRules
{
    /// <summary>The planned source's name.</summary>
    public const string PlannedSource = "calendar.sync";

    /// <summary>The event-fed source's name, whose rows the item trigger inserts.</summary>
    public const string DirtySource = "calendar.dirty";

    /// <summary>The worker job kind.</summary>
    public const string JobKind = "calendar.sync";

    /// <summary>Bound on a title and a location.</summary>
    public const int MaxTextLength = 500;

    /// <summary>Bound on an event's details.</summary>
    public const int MaxDetailsLength = 8000;

    /// <summary>Bound on an external id.</summary>
    public const int MaxExternalIdLength = 500;

    /// <summary>Bound on a provider version and on a cursor.</summary>
    public const int MaxVersionLength = 4096;

    /// <summary>Bound on a log row's detail and a stored error.</summary>
    public const int MaxDetailLength = 500;

    /// <summary>
    /// Pushes of one pair that may fail in a row before it is parked: no longer handed out until
    /// the item is edited again (a create or update), or tombstoned with a conflict (a delete).
    /// </summary>
    public const short MaxPushFailures = 5;

    /// <summary>The planned poll interval.</summary>
    public static readonly TimeSpan PlannedInterval = TimeSpan.FromMinutes(5);

    /// <summary>How long a cursor may lag the window before the pull re-baselines (monthly).</summary>
    public static readonly TimeSpan RebaselineAfter = TimeSpan.FromDays(31);

    private const string MinuteFormat = "yyyyMMddHHmm";

    /// <summary>
    /// Decides a pulled event against its item. The provider wins for a read-only event, when Nix
    /// did not change, or when its modification is strictly later than the item's; otherwise the
    /// Nix edit is kept and pushed.
    /// </summary>
    public static CalendarSyncWinner Decide(bool readOnly, bool nixChanged, DateTimeOffset providerUpdatedAt, DateTimeOffset itemUpdatedAt) =>
        readOnly || !nixChanged || providerUpdatedAt > itemUpdatedAt
            ? CalendarSyncWinner.Provider
            : CalendarSyncWinner.Nix;

    /// <summary>SHA-256 over the canonical JSON array <c>[title,start,end,location,details]</c>.</summary>
    public static byte[] Hash(string title, string start, string? end, string location, string details)
    {
        using var buffer = new MemoryStream(256);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartArray();
            writer.WriteStringValue(title);
            writer.WriteStringValue(start);
            if (end is null)
            {
                writer.WriteNullValue();
            }
            else
            {
                writer.WriteStringValue(end);
            }

            writer.WriteStringValue(location);
            writer.WriteStringValue(details);
            writer.WriteEndArray();
        }

        return SHA256.HashData(buffer.GetBuffer().AsSpan(0, (int)buffer.Length));
    }

    /// <summary>Drops every control character except newline and tab; provider text is plain.</summary>
    public static string Sanitize(string? text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return string.Empty;
        }

        if (!text.Any(character => char.IsControl(character) && character is not '\n' and not '\t'))
        {
            return text;
        }

        var builder = new StringBuilder(text.Length);
        foreach (var character in text)
        {
            if (!char.IsControl(character) || character is '\n' or '\t')
            {
                builder.Append(character);
            }
        }

        return builder.ToString();
    }

    /// <summary>Cuts <paramref name="text"/> to at most <paramref name="maximum"/> characters.</summary>
    public static string Bound(string? text, int maximum)
    {
        if (string.IsNullOrEmpty(text))
        {
            return string.Empty;
        }

        if (text.Length <= maximum)
        {
            return text;
        }

        var cut = maximum;
        if (char.IsHighSurrogate(text[cut - 1]))
        {
            cut--;
        }

        return text[..cut];
    }

    /// <summary>The pull window: UTC midnight <paramref name="pastDays"/> ago to UTC midnight <paramref name="futureDays"/> + 1 ahead.</summary>
    public static (DateTimeOffset Start, DateTimeOffset End) Window(DateTimeOffset now, int pastDays, int futureDays)
    {
        var today = new DateTimeOffset(now.UtcDateTime.Date, TimeSpan.Zero);
        return (today.AddDays(-pastDays), today.AddDays(futureDays + 1));
    }

    /// <summary>
    /// Whether this round must pull without a cursor: a full sync was asked for, there is no cursor,
    /// the cursor's window start lags the new one by more than 31 days (the monthly re-baseline), or
    /// the window's size changed.
    /// </summary>
    public static bool RequiresFullResync(
        bool fullRequested,
        string? cursor,
        DateTimeOffset? cursorWindowStart,
        DateTimeOffset? cursorWindowEnd,
        DateTimeOffset windowStart,
        DateTimeOffset windowEnd) =>
        fullRequested
        || string.IsNullOrEmpty(cursor)
        || cursorWindowStart is not { } previousStart
        || cursorWindowEnd is not { } previousEnd
        || windowStart - previousStart > RebaselineAfter
        || windowEnd - windowStart != previousEnd - previousStart;

    /// <summary>A link's stable offset into each five-minute slot, spreading links over it.</summary>
    public static TimeSpan Stagger(Guid linkId)
    {
        Span<byte> bytes = stackalloc byte[16];
        linkId.TryWriteBytes(bytes);
        var mixed = BinaryPrimitives.ReadUInt32LittleEndian(bytes)
            ^ BinaryPrimitives.ReadUInt32LittleEndian(bytes[4..])
            ^ BinaryPrimitives.ReadUInt32LittleEndian(bytes[8..])
            ^ BinaryPrimitives.ReadUInt32LittleEndian(bytes[12..]);
        return TimeSpan.FromSeconds(mixed % 300);
    }

    /// <summary>
    /// The next planned fire of a link at or after <paramref name="notBefore"/>: a five-minute UTC
    /// boundary plus the link's stagger. Replanning at any instant up to the fire time returns the
    /// same slot, so a staggered trigger is never cancelled before it is due.
    /// </summary>
    public static (DateTimeOffset Slot, DateTimeOffset FireAt) PlannedSlot(Guid linkId, DateTimeOffset notBefore)
    {
        var stagger = Stagger(linkId);
        var shifted = notBefore.ToUniversalTime() - stagger;
        var ticks = PlannedInterval.Ticks;
        var remainder = shifted.UtcTicks % ticks;
        var slotTicks = remainder == 0 ? shifted.UtcTicks : shifted.UtcTicks - remainder + ticks;
        var slot = new DateTimeOffset(slotTicks, TimeSpan.Zero);
        return (slot, slot + stagger);
    }

    /// <summary>The planned source's dedupe key.</summary>
    public static string PlannedKey(Guid linkId, DateTimeOffset slot) =>
        $"cal:p:{linkId:D}:{Minute(slot)}";

    /// <summary>The event-fed source's dedupe key (the same shape the item trigger writes).</summary>
    public static string DirtyKey(Guid linkId, DateTimeOffset minute) =>
        $"cal:d:{linkId:D}:{Minute(minute)}";

    /// <summary>Parses a calendar trigger's dedupe key.</summary>
    public static bool TryParseKey(string? key, out CalendarTriggerKey parsed)
    {
        parsed = default;
        if (key is null)
        {
            return false;
        }

        if (key.Length != 6 + 36 + 1 + 12 || !key.StartsWith("cal:", StringComparison.Ordinal) || key[5] != ':' || key[42] != ':')
        {
            return false;
        }

        CalendarTriggerKind kind;
        switch (key[4])
        {
            case 'p':
                kind = CalendarTriggerKind.Planned;
                break;
            case 'd':
                kind = CalendarTriggerKind.Dirty;
                break;
            default:
                return false;
        }

        if (!Guid.TryParseExact(key.AsSpan(6, 36), "D", out var linkId)
            || !DateTime.TryParseExact(key.AsSpan(43), MinuteFormat, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var minute))
        {
            return false;
        }

        parsed = new CalendarTriggerKey(kind, linkId, new DateTimeOffset(DateTime.SpecifyKind(minute, DateTimeKind.Utc)));
        return true;
    }

    /// <summary>
    /// The job idempotency key a fired trigger enqueues under. The source letter keeps a planned
    /// round and a dirty round of the same minute apart, so one never swallows the other's changes.
    /// </summary>
    public static string JobKey(CalendarTriggerKey key) =>
        $"link:{key.LinkId:D}:{(key.Kind == CalendarTriggerKind.Planned ? 'p' : 'd')}:{Minute(key.Minute)}";

    /// <summary>The job idempotency key of a "sync now" request, coalescing clicks within a minute.</summary>
    public static string NowJobKey(Guid linkId, DateTimeOffset now, bool full) =>
        $"link:{linkId:D}:now:{Minute(now)}:{(full ? 'f' : 'i')}";

    /// <summary>
    /// The instant an event's stored start value denotes: a <c>yyyy-MM-dd</c> date is its UTC
    /// midnight, an RFC 9557 timestamp its own instant; anything else has none.
    /// </summary>
    public static DateTimeOffset? StartInstant(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return null;
        }

        if (value.Length == 10)
        {
            return DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day)
                ? new DateTimeOffset(day.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero)
                : null;
        }

        var bracket = value.IndexOf('[', StringComparison.Ordinal);
        var instant = bracket > 0 ? value[..bracket] : value;
        return DateTimeOffset.TryParseExact(
            instant,
            ["yyyy-MM-dd'T'HH:mm:ssK", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK", "yyyy-MM-dd'T'HH:mmK"],
            CultureInfo.InvariantCulture,
            DateTimeStyles.None,
            out var parsed)
            ? parsed.ToUniversalTime()
            : null;
    }

    private static string Minute(DateTimeOffset instant) =>
        instant.UtcDateTime.ToString(MinuteFormat, CultureInfo.InvariantCulture);
}
