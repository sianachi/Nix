using Nix.Domain.Audit;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Features.Roles;

/// <summary>Builds the tenant-level audit event for a grant or revocation; the subject is the principal affected.</summary>
internal static class AccessAudit
{
    internal static AuditEvent Event(TenantId tenant, PrincipalId actor, string action, Guid subject, DateTimeOffset now) => new()
    {
        Id = AuditEventId.Create(),
        TenantId = tenant,
        WorkspaceId = null,
        ActorId = actor,
        OnBehalfOf = null,
        Action = action,
        SubjectId = subject,
        SubjectType = "principal",
        Before = null,
        After = null,
        ActorIp = null,
        OccurredAt = now,
    };
}
