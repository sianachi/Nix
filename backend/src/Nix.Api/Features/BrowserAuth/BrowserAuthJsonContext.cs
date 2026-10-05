using System.Text.Json.Serialization;

namespace Nix.Features.BrowserAuth;

/// <summary>Source-generated JSON metadata for browser authentication.</summary>
[JsonSerializable(typeof(BrowserSessionResponse))]
[JsonSerializable(typeof(BrowserProfileResponse))]
[JsonSerializable(typeof(BrowserTokenResponse))]
internal sealed partial class BrowserAuthJsonContext : JsonSerializerContext;
