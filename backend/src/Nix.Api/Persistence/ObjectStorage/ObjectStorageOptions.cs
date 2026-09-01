namespace Nix.Persistence.ObjectStorage;

/// <summary>Private S3-compatible storage used through short-lived object capabilities.</summary>
public sealed class ObjectStorageOptions
{
    /// <summary>Configuration section.</summary>
    public const string SectionName = "Nix:ObjectStorage";

    /// <summary>Gets or sets the path-style S3 endpoint.</summary>
    public Uri? Endpoint { get; set; }

    /// <summary>Gets or sets the signing region.</summary>
    public string Region { get; set; } = string.Empty;

    /// <summary>Gets or sets the private bucket.</summary>
    public string Bucket { get; set; } = string.Empty;

    /// <summary>Gets or sets the S3 access key identifier.</summary>
    public string AccessKey { get; set; } = string.Empty;

    /// <summary>Gets or sets the S3 secret signing key.</summary>
    public string SecretKey { get; set; } = string.Empty;

    /// <summary>Gets or sets the capability lifetime in seconds.</summary>
    public int CapabilitySeconds { get; set; } = 300;
}
