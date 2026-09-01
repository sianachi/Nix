using System.Text.Json.Serialization;

namespace Nix.Features.Plugins;

public sealed record BeginPluginComponentUploadRequest(
    string PublisherId,
    string Id,
    string Version,
    string Sha256,
    long ByteLength,
    string PublicKey,
    string Signature);

public sealed record PluginComponentUploadResponse(
    string ObjectKey,
    Uri UploadUrl,
    DateTimeOffset ExpiresAt,
    string IfNoneMatch,
    string XAmzChecksumSha256);

public sealed record PluginInstallationResponse(
    Guid Id,
    Guid WorkspaceId,
    string PublisherId,
    string ComponentId,
    string Version,
    string Sha256,
    long ByteLength,
    bool Enabled,
    IReadOnlyList<string> Capabilities,
    DateTimeOffset InstalledAt,
    DateTimeOffset UpdatedAt);

public sealed record SetPluginEnabledRequest(bool Enabled);

public sealed record ReplacePluginCapabilitiesRequest(IReadOnlyList<string> Capabilities);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(BeginPluginComponentUploadRequest))]
[JsonSerializable(typeof(PluginComponentRegistrationRequest))]
[JsonSerializable(typeof(PluginComponentUploadResponse))]
[JsonSerializable(typeof(PluginInstallationResponse))]
[JsonSerializable(typeof(IReadOnlyList<PluginInstallationResponse>))]
[JsonSerializable(typeof(SetPluginEnabledRequest))]
[JsonSerializable(typeof(ReplacePluginCapabilitiesRequest))]
[JsonSerializable(typeof(IReadOnlyList<string>))]
internal sealed partial class PluginsJsonContext : JsonSerializerContext;
