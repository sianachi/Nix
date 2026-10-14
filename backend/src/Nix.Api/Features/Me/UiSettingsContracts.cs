using System.Text.Json;
using Nix.Messaging;

namespace Nix.Features.CurrentUser;

/// <summary>The caller's synced interface settings and the write counter they were read at.</summary>
/// <param name="Settings">The stored keys only; a key the person never set is absent, so the client keeps its own default.</param>
/// <param name="Revision">Zero when never written; advances on every write. Informational: writes merge per key and never compare it.</param>
public sealed record UiSettingsResponse(IReadOnlyDictionary<string, JsonElement> Settings, long Revision);

/// <summary>A per-key merge: a value sets the key, <c>null</c> deletes it, absent keys are untouched.</summary>
public sealed record PatchUiSettingsRequest(IReadOnlyDictionary<string, JsonElement>? Settings);

/// <summary>Reads the caller's own settings, empty when never written.</summary>
public sealed record GetUiSettings : IQuery<UiSettingsResponse>;

/// <summary>Merges a patch into the caller's own settings.</summary>
public sealed record PatchUiSettings(IReadOnlyDictionary<string, JsonElement>? Settings) : ICommand<UiSettingsResponse>;
