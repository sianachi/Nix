using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Views;

/// <summary>A revocable public capability for one interactive form view.</summary>
public sealed class PublicFormLink
{
    /// <summary>Gets the opaque link identity.</summary>
    public required Guid Id { get; init; }
    public required TenantId TenantId { get; init; }
    public required WorkspaceId WorkspaceId { get; init; }
    public required ItemId ItemId { get; init; }
    public required string ViewId { get; init; }
    public required string Nonce { get; set; }
    public required PrincipalId SubmissionPrincipalId { get; init; }
    public required PrincipalId PublishedBy { get; set; }
    public required DateTimeOffset PublishedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
}
