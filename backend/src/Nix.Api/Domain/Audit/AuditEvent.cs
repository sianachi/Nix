using System.Net;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Audit;

/// <summary>
/// One recorded act: who did what to which subject, and what the subject looked like either side
/// of it.
/// </summary>
/// <remarks>
/// <para>
/// Insert-only, enforced by grant rather than by discipline. The runtime role may add rows to this
/// table and may not update or delete them, so a compromise that can rewrite application data
/// still cannot rewrite the record of having done so. The audit goal asserts those grants against
/// the live database.
/// </para>
/// <para>
/// <b>Content never lands here.</b> <see cref="Before"/> and <see cref="After"/> hold the envelope
/// - names, parents, roles, lifecycle - and never a document body, a file's bytes, or extracted
/// text. An audit store is retained longer than the data it describes and is read by people who
/// were never granted the content, so copying content into it would quietly launder both the
/// retention policy and the permission model.
/// </para>
/// </remarks>
public sealed class AuditEvent
{
    /// <summary>Gets the event's identifier.</summary>
    public required AuditEventId Id { get; init; }

    /// <summary>Gets the tenant the act took place in.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>
    /// Gets the workspace in scope, or <see langword="null"/> for tenant-wide acts such as role
    /// administration.
    /// </summary>
    public WorkspaceId? WorkspaceId { get; init; }

    /// <summary>Gets the principal who acted.</summary>
    public required PrincipalId ActorId { get; init; }

    /// <summary>
    /// Gets the principal the actor acted for, when an administrator acted on someone's behalf.
    /// </summary>
    /// <remarks>
    /// Separate from <see cref="ActorId"/> so support-initiated changes are distinguishable from
    /// the account owner's own. Collapsing the two would make impersonation invisible.
    /// </remarks>
    public PrincipalId? OnBehalfOf { get; init; }

    /// <summary>
    /// Gets what was done, as a stable dotted verb such as <c>item.moved</c>.
    /// </summary>
    public required string Action { get; init; }

    /// <summary>Gets the identifier of what was acted on.</summary>
    public required Guid SubjectId { get; init; }

    /// <summary>Gets what kind of thing the subject is - item, principal, workspace, acl entry.</summary>
    public required string SubjectType { get; init; }

    /// <summary>
    /// Gets the subject's envelope before the act as JSON, or <see langword="null"/> for a
    /// creation.
    /// </summary>
    public string? Before { get; init; }

    /// <summary>
    /// Gets the subject's envelope after the act as JSON, or <see langword="null"/> for a
    /// deletion.
    /// </summary>
    public string? After { get; init; }

    /// <summary>
    /// Gets the address the request came from, or <see langword="null"/> when the act had no
    /// request behind it - a scheduled purge, a retention sweep.
    /// </summary>
    public IPAddress? ActorIp { get; init; }

    /// <summary>Gets when the act took place.</summary>
    public required DateTimeOffset OccurredAt { get; init; }
}
