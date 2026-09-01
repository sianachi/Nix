using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Files;

/// <summary>The durable body of an item whose open body kind is <c>file</c>.</summary>
public sealed class FileBody
{
    public required ItemId ItemId { get; init; }
    public required TenantId TenantId { get; init; }
    public required WorkspaceId WorkspaceId { get; init; }
    public required FileVersionId CurrentVersionId { get; set; }
}
