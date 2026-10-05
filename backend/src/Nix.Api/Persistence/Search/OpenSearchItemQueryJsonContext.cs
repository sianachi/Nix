using System.Text.Json.Serialization;

namespace Nix.Persistence.Search;

[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Metadata)]
[JsonSerializable(typeof(OpenSearchResponseEnvelope))]
internal sealed partial class OpenSearchItemQueryJsonContext : JsonSerializerContext;

internal sealed class OpenSearchResponseEnvelope
{
    [JsonPropertyName("hits")]
    [JsonRequired]
    public OpenSearchResponseHits? Hits { get; init; }
}

internal sealed class OpenSearchResponseHits
{
    [JsonPropertyName("hits")]
    [JsonRequired]
    public OpenSearchHit[]? Hits { get; init; }
}

internal sealed class OpenSearchHit
{
    [JsonPropertyName("_source")]
    [JsonRequired]
    public OpenSearchHitSource? Source { get; init; }
}

internal sealed class OpenSearchHitSource
{
    [JsonPropertyName("tenant_id")]
    [JsonRequired]
    public string? TenantId { get; init; }

    [JsonPropertyName("workspace_id")]
    [JsonRequired]
    public string? WorkspaceId { get; init; }

    [JsonPropertyName("item_id")]
    [JsonRequired]
    public string? ItemId { get; init; }

    [JsonPropertyName("type")]
    [JsonRequired]
    public string? Type { get; init; }

    [JsonPropertyName("title")]
    [JsonRequired]
    public string? Title { get; init; }

    [JsonPropertyName("lifecycle_state")]
    [JsonRequired]
    public string? LifecycleState { get; init; }

    [JsonPropertyName("hidden")]
    [JsonRequired]
    public bool? Hidden { get; init; }

    [JsonPropertyName("deleted")]
    [JsonRequired]
    public bool? Deleted { get; init; }
}
