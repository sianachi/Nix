using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nix.Abstractions;
using Nix.Domain.Audit;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Views;

namespace Nix.Persistence;

/// <summary>EF-backed storage for revocable public form capabilities.</summary>
public sealed class PublicFormStore : IPublicFormStore
{
    private readonly NixDbContext _database;
    private readonly ScopedNixSessionContextAccessor _session;

    /// <summary>Initializes a store sharing the request's database unit of work.</summary>
    public PublicFormStore(NixDbContext database, ScopedNixSessionContextAccessor session)
    {
        _database = database;
        _session = session;
    }

    /// <inheritdoc />
    public async ValueTask<IPublicFormTransaction> BeginAsync(
        NixSessionContext context,
        CancellationToken cancellationToken)
    {
        _session.Set(context);
        var transaction = await _database.Database.BeginTransactionAsync(cancellationToken)
            .ConfigureAwait(false);
        return new PublicFormTransaction(transaction);
    }

    /// <inheritdoc />
    public async ValueTask<PublicFormLink?> FindAsync(Guid linkId, CancellationToken cancellationToken) =>
        await _database.PublicFormLinks.SingleOrDefaultAsync(
            link => link.Id == linkId,
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<bool> IsActivePrincipalAsync(
        PrincipalId principalId,
        CancellationToken cancellationToken) =>
        await _database.Principals.AnyAsync(
            principal => principal.Id == principalId && principal.Status == PrincipalStatus.Active,
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<PublicFormLink?> FindForUpdateAsync(
        ItemId itemId,
        string viewId,
        CancellationToken cancellationToken) =>
        await _database.PublicFormLinks.AsTracking().SingleOrDefaultAsync(
            link => link.ItemId == itemId && link.ViewId == viewId,
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public void Add(PublicFormLink link, Principal principal, WorkspaceMember membership)
    {
        _database.Principals.Add(principal);
        _database.WorkspaceMembers.Add(membership);
        _database.PublicFormLinks.Add(link);
    }

    /// <inheritdoc />
    public void AddAudit(AuditEvent auditEvent) => _database.AuditEvents.Add(auditEvent);

    /// <inheritdoc />
    public Task SaveAsync(CancellationToken cancellationToken) =>
        _database.SaveChangesAsync(cancellationToken);

    private sealed class PublicFormTransaction(IDbContextTransaction transaction) : IPublicFormTransaction
    {
        public Task CommitAsync(CancellationToken cancellationToken) =>
            transaction.CommitAsync(cancellationToken);

        public ValueTask DisposeAsync() => transaction.DisposeAsync();
    }
}
