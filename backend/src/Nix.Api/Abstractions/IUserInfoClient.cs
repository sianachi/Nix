namespace Nix.Abstractions;

/// <summary>Bounded, non-sensitive stage at which first-login provisioning became unavailable.</summary>
public enum ProvisioningFailureCategory
{
    /// <summary>The stored UserInfo endpoint is not safe for the validated issuer.</summary>
    Endpoint,
    /// <summary>The provider returned an unsuccessful HTTP status.</summary>
    UserInfoStatus,
    /// <summary>The complete bounded UserInfo operation timed out.</summary>
    UserInfoTimeout,
    /// <summary>The provider response or claims were malformed.</summary>
    UserInfoMalformed,
    /// <summary>The provider transport failed without exposing response data.</summary>
    UserInfoTransport,
    /// <summary>The durable provisioning write failed.</summary>
    Database,
    /// <summary>A durable provisioning invariant did not hold.</summary>
    Invariant,
}

/// <summary>Reads the bounded identity claims required for first-login provisioning.</summary>
public interface IUserInfoClient
{
    /// <summary>Reads and validates one OIDC UserInfo response.</summary>
    /// <param name="endpoint">The stored endpoint to call.</param>
    /// <param name="validatedIssuer">The exact issuer whose origin the endpoint must share.</param>
    /// <param name="accessToken">The already validated bearer token.</param>
    /// <param name="expectedSubject">The validated subject UserInfo must repeat exactly.</param>
    /// <param name="cancellationToken">Cancels the complete headers-and-body operation.</param>
    public ValueTask<UserInfoProfile> ReadAsync(
        Uri endpoint,
        string validatedIssuer,
        string accessToken,
        string expectedSubject,
        CancellationToken cancellationToken);
}

/// <summary>Claims accepted from a validated OIDC UserInfo response.</summary>
/// <param name="DisplayName">The bounded provider-supplied name, or null when absent.</param>
/// <param name="Email">The bounded email, if supplied.</param>
/// <param name="EmailVerified">Whether the provider verified the email.</param>
public sealed record UserInfoProfile(
    string? DisplayName,
    string? Email,
    bool EmailVerified);

/// <summary>An upstream UserInfo response could not safely authorize provisioning.</summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Design",
    "CA1032:Implement standard exception constructors",
    Justification = "Caller-owned messages could disclose provider claims; failures use a closed category instead.")]
public sealed class UserInfoUnavailableException : Exception
{
    /// <summary>Initializes a refusal with a closed non-sensitive category.</summary>
    public UserInfoUnavailableException(ProvisioningFailureCategory category)
        : base("The registered identity provider could not supply valid provisioning claims.") => Category = category;

    /// <summary>Initializes a refusal without retaining provider response data.</summary>
    public UserInfoUnavailableException()
        : this(ProvisioningFailureCategory.UserInfoMalformed)
    {
    }

    /// <summary>Initializes a refusal with a non-sensitive transport cause.</summary>
    public UserInfoUnavailableException(Exception innerException)
        : this(ProvisioningFailureCategory.UserInfoTransport, innerException)
    {
    }

    /// <summary>Initializes a refusal with a closed category and a non-sensitive transport cause.</summary>
    public UserInfoUnavailableException(ProvisioningFailureCategory category, Exception innerException)
        : base("The registered identity provider could not supply valid provisioning claims.", innerException) => Category = category;

    /// <summary>Gets the safe operational category.</summary>
    public ProvisioningFailureCategory Category { get; }
}
