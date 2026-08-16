using System.Text.Json.Serialization;
using Nix.Authentication;
using Nix.Features.Tokens;

namespace Nix.Serialization;

/// <summary>
/// The token feature's JSON contract, source-generated: management under <c>/me/tokens</c>, the
/// exchange under <c>/public/v1/auth</c>, and the key set beside it.
/// </summary>
/// <remarks>
/// One context per feature; <c>Program</c> chains them all onto the serializer's resolver chain.
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(CreateAccessTokenRequest))]
[JsonSerializable(typeof(AccessTokenListResponse))]
[JsonSerializable(typeof(CreatedAccessTokenResponse))]
[JsonSerializable(typeof(TokenExchangeRequest))]
[JsonSerializable(typeof(TokenExchangeResponse))]
[JsonSerializable(typeof(JwksResponse))]
internal sealed partial class TokensJsonContext : JsonSerializerContext;
