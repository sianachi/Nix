using System.Text.Json.Serialization;

namespace Nix.Features.Speech;

/// <summary>Asks for a capability to use the speech worker interactively.</summary>
/// <param name="Purpose"><c>synthesize</c> to have text spoken, <c>dictate</c> to have speech transcribed.</param>
public sealed record CreateSpeechCapabilityRequest(string? Purpose);

/// <summary>A short-lived, single-purpose capability for the speech worker.</summary>
/// <param name="Token">Opaque. Presented to the speech worker, never parsed by the client.</param>
/// <param name="ExpiresAt">When it stops working. Ask for another before then.</param>
public sealed record SpeechCapabilityResponse(string Token, DateTimeOffset ExpiresAt);

/// <summary>The speech worker handing a presented capability back to Core.</summary>
/// <param name="Token">The token the browser presented.</param>
/// <param name="Purpose">What the worker is about to do with it.</param>
public sealed record RedeemSpeechCapabilityRequest(string? Token, string? Purpose);

/// <summary>Whose capability it was.</summary>
/// <param name="TenantId">The tenant it was issued in.</param>
/// <param name="PrincipalId">The principal it was issued to.</param>
/// <param name="ExpiresAt">When it stops being redeemable.</param>
public sealed record RedeemSpeechCapabilityResponse(Guid TenantId, Guid PrincipalId, DateTimeOffset ExpiresAt);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(CreateSpeechCapabilityRequest))]
[JsonSerializable(typeof(SpeechCapabilityResponse))]
[JsonSerializable(typeof(RedeemSpeechCapabilityRequest))]
[JsonSerializable(typeof(RedeemSpeechCapabilityResponse))]
internal sealed partial class SpeechJsonContext : JsonSerializerContext;
