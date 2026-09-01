namespace Nix.Persistence.Search;

/// <summary>Controls the feature-flagged OpenSearch read path.</summary>
public sealed class SearchProviderOptions
{
    /// <summary>The configuration section owned by search persistence.</summary>
    public const string SectionName = "Nix:Search";

    /// <summary>The named HTTP transport used only for bounded OpenSearch queries.</summary>
    public const string HttpClientName = "nix-opensearch-query";

    /// <summary>Gets or sets whether text queries use OpenSearch instead of Postgres.</summary>
    public bool OpenSearchEnabled { get; set; }

    /// <summary>Gets or sets the private OpenSearch HTTP origin.</summary>
    public Uri? OpenSearchUrl { get; set; }

    /// <summary>Gets or sets the exact index or read-alias name.</summary>
    public string OpenSearchIndex { get; set; } = "nix-items";

    /// <summary>Gets or sets the complete OpenSearch exchange deadline.</summary>
    public int TimeoutMilliseconds { get; set; } = 2000;
}
