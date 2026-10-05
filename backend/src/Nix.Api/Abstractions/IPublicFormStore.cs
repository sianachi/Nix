using Nix.Domain.Audit;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Views;

namespace Nix.Abstractions;

/// <summary>Stores public form capabilities and establishes their isolated submission unit of work.</summary>
public interface IPublicFormStore
{
    /// <summary>Begins a tenant-scoped transaction acting as the form's service principal.</summary>
    public ValueTask<IPublicFormTransaction> BeginAsync(
        NixSessionContext context,
        CancellationToken cancellationToken);

    /// <summary>Finds a capability without tracking it.</summary>
    public ValueTask<PublicFormLink?> FindAsync(Guid linkId, CancellationToken cancellationToken);

    /// <summary>Whether the capability's dedicated service identity may still act.</summary>
    public ValueTask<bool> IsActivePrincipalAsync(
        PrincipalId principalId,
        CancellationToken cancellationToken);

    /// <summary>Finds the capability for an item view and tracks it for rotation or revocation.</summary>
    public ValueTask<PublicFormLink?> FindForUpdateAsync(
        ItemId itemId,
        string viewId,
        CancellationToken cancellationToken);

    /// <summary>Adds a capability and its dedicated identity and workspace membership.</summary>
    public void Add(PublicFormLink link, Principal principal, WorkspaceMember membership);

    /// <summary>Adds an insert-only audit record.</summary>
    public void AddAudit(AuditEvent auditEvent);

    /// <summary>Flushes pending capability, identity, membership, and audit changes.</summary>
    public Task SaveAsync(CancellationToken cancellationToken);
}

/// <summary>A public submission's tenant-scoped transaction.</summary>
public interface IPublicFormTransaction : IAsyncDisposable
{
    /// <summary>Commits the response and its audit record atomically.</summary>
    public Task CommitAsync(CancellationToken cancellationToken);
}
