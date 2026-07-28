namespace Nix.Features.Workspaces;

/// <summary>
/// A workspace as the API presents it.
/// </summary>
/// <param name="Id">The workspace's identifier.</param>
/// <param name="Name">Its display name.</param>
/// <param name="VersionRetentionDays">How long non-pinned version history is kept.</param>
/// <param name="StorageQuotaBytes">The workspace's storage ceiling.</param>
/// <param name="CreatedAt">When it was created.</param>
/// <remarks>
/// No <c>tenantId</c>. The tenant is not a client concern: every request is already scoped to one
/// by the session, a client can never address another, and putting it in the payload would invite
/// the frontend to filter on it - which is the beginning of computing permissions on the client.
/// </remarks>
internal sealed record WorkspaceResponse(
    Guid Id,
    string Name,
    int VersionRetentionDays,
    long StorageQuotaBytes,
    DateTimeOffset CreatedAt);
