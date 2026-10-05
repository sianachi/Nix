using System.Text.Json.Serialization;

namespace Nix.Features.Pets;

/// <summary>Independent appearance and communication preferences for one companion.</summary>
public sealed record PetProfile(Guid Id, string Name, string Appearance, string Personality, string ResponseLength, string Instructions);

/// <summary>Account preferences. Device voices and placement are deliberately absent.</summary>
/// <remarks>
/// <c>InlineWriting</c> is the separate opt-in for sending text the person selects in a note to
/// the model provider from the editor. It defaults to off, and settings stored before it existed
/// read as off. It is the last member so a stored document without it still deserialises.
/// </remarks>
public sealed record PetSettings(bool Enabled, Guid? ActivePetId, string Motion, bool Narration, IReadOnlyList<PetProfile> Profiles, bool InlineWriting = false);

/// <summary>The saved document and its concurrency version.</summary>
public sealed record PetSettingsResponse(long Revision, PetSettings Settings);

/// <summary>Replaces the owner's preferences only at the version they edited.</summary>
public sealed record SavePetSettingsRequest(long ExpectedRevision, PetSettings Settings);

/// <summary>Truthful provider availability without credentials or inferred entitlements.</summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1054", Justification = "The wire contract uses an empty string when no device login is pending; clients allowlist the provider URL.")]
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1056", Justification = "The wire contract uses an empty string when no device login is pending; clients allowlist the provider URL.")]
public sealed record PetConnectionResponse(string Provider, string Status, string Reason, bool CanConnect,
    string VerificationUrl = "", string UserCode = "", string State = "idle", IReadOnlyList<PetMessage>? Messages = null,
    IReadOnlyList<PetModel>? Models = null, IReadOnlyList<PetToolCall>? Tools = null, IReadOnlyList<PetHistoryEntry>? History = null,
    long Revision = 0);

/// <summary>A private archived conversation in this workspace and pet.</summary>
public sealed record PetHistoryEntry(string Id, string Title, string CreatedAt);

/// <summary>A model offered by the connected Codex runtime.</summary>
public sealed record PetModel(string Id, string Name, bool Default);

/// <summary>A bounded tool request and its private execution receipt.</summary>
public sealed record PetToolCall(string Id, string Arguments, string Status, string Result, string ClaimId);

/// <summary>A proposed, never automatically executed workspace change.</summary>
public sealed record PetAction(string Kind, string ItemId, string Title);

/// <summary>One private conversation message.</summary>
public sealed record PetMessage(string Id, string Role, string Text, IReadOnlyList<PetAction> Actions);

/// <summary>Companion operation. Identity and permissions are always derived by Core.</summary>
public sealed record PetRuntimeRequest(string Operation, Guid? WorkspaceId = null, Guid? PetId = null,
    Guid? RequestId = null, string Text = "", Guid? ItemId = null, string SharedText = "",
    string Model = "", bool WorkspaceAccess = false, string ToolId = "", string ToolResult = "", bool ToolSuccess = false, Guid? HistoryId = null,
    string Mode = "");

internal sealed record PetWorkerRequest(string TenantId, string PrincipalId, string WorkspaceId,
    string PetId, string Operation, string RequestId, string Text, string Instructions,
    string ItemId, string ItemTitle, string SharedText, string Model, bool WorkspaceAccess,
    string ToolId, string ToolResult, bool ToolSuccess, string HistoryId, string Mode, long After);

/// <summary>One inline writing request from the editor: the person's selection and what to do with it.</summary>
/// <param name="WorkspaceId">The workspace the item is in.</param>
/// <param name="ItemId">The item being edited; the caller must be able to read it and it must not be locked.</param>
/// <param name="RequestId">Client-chosen identity of this request, passed to the worker for tracing and de-duplication.</param>
/// <param name="Kind">One of continue, summarise, improve, fix, translate, action_items, custom.</param>
/// <param name="Selection">The material to work on (16,000 bytes of UTF-8 at most); empty only for continue and custom.</param>
/// <param name="Instruction">The person's own words; required for custom (2,000 bytes at most).</param>
/// <param name="Context">Surrounding text for orientation (32,000 bytes of UTF-8 at most).</param>
/// <param name="Language">The target language; required for translate (64 bytes at most).</param>
/// <param name="Model">An optional model identifier offered by the connected runtime.</param>
public sealed record PetInlineRequest(Guid WorkspaceId, Guid ItemId, Guid RequestId, string Kind,
    string Selection, string? Instruction = null, string? Context = null, string? Language = null, string? Model = null);

/// <summary>The worker's inline operation. Unknown fields are refused by the worker, so this is exactly its shape.</summary>
internal sealed record PetInlineWorkerRequest(string TenantId, string PrincipalId, string WorkspaceId,
    string PetId, string Operation, string RequestId, string Text, string SharedText, string ContextText,
    string InlineKind, string Language, string Model);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(PetSettings))]
[JsonSerializable(typeof(PetSettingsResponse))]
[JsonSerializable(typeof(SavePetSettingsRequest))]
[JsonSerializable(typeof(PetConnectionResponse))]
[JsonSerializable(typeof(PetRuntimeRequest))]
[JsonSerializable(typeof(PetInlineRequest))]
[JsonSerializable(typeof(PetWorkerRequest))]
[JsonSerializable(typeof(PetInlineWorkerRequest))]
internal sealed partial class PetJsonContext : JsonSerializerContext;
