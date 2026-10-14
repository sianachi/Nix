using System.Collections.Frozen;
using System.Text;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Domain.Primitives;
using Nix.Messaging;
using Nix.Serialization;

namespace Nix.Features.CurrentUser;

/// <summary>
/// The trust boundary for synced interface settings: only known keys, each with its own value
/// type, in a document that cannot grow past a fixed size.
/// </summary>
public static class UiSettingsValidation
{
    /// <summary>The largest patch, and the largest stored document, in UTF-8 bytes.</summary>
    public const int MaximumBytes = 16 * 1024;

    /// <summary>Stable code for a patch with an unknown key or a value of the wrong type.</summary>
    public const string InvalidCode = "me.invalid_ui_settings";

    /// <summary>Stable code for a patch over <see cref="MaximumBytes"/>.</summary>
    public const string TooLargeCode = "me.ui_settings_too_large";

    // A null value list means a boolean; otherwise the key takes one of the listed strings. The
    // enum values mirror the web stores that hold each setting today (keyboard-mode-store.ts,
    // text-width-preference.ts, suggestion-preferences.ts); graph.openMode and
    // sites.publishingEnabled have no web store yet and follow the ticket.
    private static readonly FrozenDictionary<string, string[]?> Rules = new Dictionary<string, string[]?>(StringComparer.Ordinal)
    {
        ["editor.keyboardMode"] = ["standard", "vim", "emacs"],
        ["editor.textWidth"] = ["reading", "full"],
        ["editor.pageGuides"] = null,
        ["editor.phraseSuggestions"] = null,
        ["editor.unlinkedMentionUnderline"] = null,
        ["editor.viewSuggestionOrder"] = ["on", "off"],
        ["dailyNotes.openTodayOnStart"] = null,
        ["sites.publishingEnabled"] = null,
        ["graph.openMode"] = ["page", "dialog", "beside", "tab"],
    }.ToFrozenDictionary(StringComparer.Ordinal);

    /// <summary>Returns why a patch is refused, or <see langword="null"/> when it may be merged.</summary>
    public static NixError? Check(IReadOnlyDictionary<string, JsonElement>? patch)
    {
        if (patch is null)
        {
            return new NixError(InvalidCode, "Send a settings object.");
        }

        // Size first: an oversized body is refused whatever it contains.
        var bytes = 0;
        foreach (var (key, value) in patch)
        {
            bytes += Encoding.UTF8.GetByteCount(key) + Encoding.UTF8.GetByteCount(value.GetRawText());
            if (bytes > MaximumBytes)
            {
                return new NixError(TooLargeCode, "Those settings are too large to save.");
            }
        }

        foreach (var (key, value) in patch)
        {
            if (!Rules.TryGetValue(key, out var allowed))
            {
                return new NixError(InvalidCode, $"'{key}' is not a setting that can be saved.");
            }

            var ok = value.ValueKind == JsonValueKind.Null
                || (allowed is null
                    ? value.ValueKind is JsonValueKind.True or JsonValueKind.False
                    : value.ValueKind == JsonValueKind.String && allowed.Contains(value.GetString(), StringComparer.Ordinal));
            if (!ok)
            {
                return new NixError(InvalidCode, $"'{key}' has a value of the wrong type or an unknown option.");
            }
        }

        return null;
    }

    internal static UiSettingsResponse ToResponse(string? settingsJson, long revision) =>
        new(settingsJson is null
            ? new Dictionary<string, JsonElement>()
            : JsonSerializer.Deserialize(settingsJson, MeJsonContext.Default.DictionaryStringJsonElement) ?? [], revision);
}

/// <summary>Reads only the session owner's settings.</summary>
public sealed class GetUiSettingsHandler(IPrincipalUiSettingsStore store, INixSessionContextAccessor session) : IQueryHandler<GetUiSettings, UiSettingsResponse>
{
    /// <inheritdoc />
    public async ValueTask<UiSettingsResponse> HandleAsync(GetUiSettings query, CancellationToken cancellationToken)
    {
        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var row = await store.FindAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false);
        return UiSettingsValidation.ToResponse(row?.SettingsJson, row?.Revision ?? 0);
    }
}

/// <summary>Merges a validated patch into the session owner's settings.</summary>
public sealed class PatchUiSettingsHandler(IPrincipalUiSettingsStore store, INixSessionContextAccessor session) : ICommandHandler<PatchUiSettings, UiSettingsResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<UiSettingsResponse>> HandleAsync(PatchUiSettings command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (UiSettingsValidation.Check(command.Settings) is { } refused)
        {
            return Result.Failure<UiSettingsResponse>(refused);
        }

        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var patch = command.Settings!;
        var set = patch.Where(pair => pair.Value.ValueKind != JsonValueKind.Null).ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        var remove = patch.Where(pair => pair.Value.ValueKind == JsonValueKind.Null).Select(pair => pair.Key).ToArray();
        var merged = await store.MergeAsync(
            context.TenantId, context.PrincipalId,
            JsonSerializer.Serialize(set, MeJsonContext.Default.DictionaryStringJsonElement), remove, cancellationToken).ConfigureAwait(false);
        return Result.Success(UiSettingsValidation.ToResponse(merged.SettingsJson, merged.Revision));
    }
}
