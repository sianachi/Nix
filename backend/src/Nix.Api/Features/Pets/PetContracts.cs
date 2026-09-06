using System.Text.Json.Serialization;

namespace Nix.Features.Pets;

/// <summary>Independent appearance and communication preferences for one companion.</summary>
public sealed record PetProfile(Guid Id, string Name, string Appearance, string Personality, string ResponseLength, string Instructions);

/// <summary>Account preferences. Device voices and placement are deliberately absent.</summary>
public sealed record PetSettings(bool Enabled, Guid? ActivePetId, string Motion, bool Narration, IReadOnlyList<PetProfile> Profiles);

/// <summary>The saved document and its concurrency version.</summary>
public sealed record PetSettingsResponse(long Revision, PetSettings Settings);

/// <summary>Replaces the owner's preferences only at the version they edited.</summary>
public sealed record SavePetSettingsRequest(long ExpectedRevision, PetSettings Settings);

/// <summary>Truthful provider availability without credentials or inferred entitlements.</summary>
public sealed record PetConnectionResponse(string Provider, string Status, string Reason, bool CanConnect);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(PetSettings))]
[JsonSerializable(typeof(PetSettingsResponse))]
[JsonSerializable(typeof(SavePetSettingsRequest))]
[JsonSerializable(typeof(PetConnectionResponse))]
internal sealed partial class PetJsonContext : JsonSerializerContext;
