using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Features.Roles;
using Nix.Messaging;

namespace Nix.Features.Sites;

/// <summary>The principals who decide first publishes: configured ones and those granted in Settings.</summary>
public sealed record ListSiteOperators : IQuery<Result<SiteOperatorListResponse>>;

/// <summary>Lets a principal of the caller's tenant decide first publishes; idempotent.</summary>
/// <param name="PrincipalId">Who to grant.</param>
public sealed record GrantSiteOperator(Guid PrincipalId) : ICommand<Guid>;

/// <summary>Takes a granted approver's right away; idempotent. Configured operators cannot be revoked.</summary>
/// <param name="PrincipalId">Who to revoke.</param>
public sealed record RevokeSiteOperator(Guid PrincipalId) : ICommand<Guid>;

/// <summary>Lists, grants and revokes site approvers. Only an existing operator may call any of it.</summary>
public sealed class SiteOperatorHandlers(
    IAccessGrantStore grants,
    IPrincipalDirectory principals,
    SiteOperators operators,
    SiteOptions options,
    INixSessionContextAccessor session,
    TimeProvider clock) :
    IQueryHandler<ListSiteOperators, Result<SiteOperatorListResponse>>,
    ICommandHandler<GrantSiteOperator, Guid>,
    ICommandHandler<RevokeSiteOperator, Guid>
{
    public async ValueTask<Result<SiteOperatorListResponse>> HandleAsync(ListSiteOperators query, CancellationToken cancellationToken)
    {
        if (!await operators.IsOperatorAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteOperatorListResponse>(SiteErrors.OperatorRequired());
        }

        var entries = new List<SiteOperatorResponse>();
        foreach (var id in options.Operators.Distinct())
        {
            // A configured id outside this tenant is not a principal here, so it is not listed.
            if (await principals.FindAsync(PrincipalId.From(id), cancellationToken).ConfigureAwait(false) is { } principal)
            {
                entries.Add(new(id, principal.DisplayName, "configured", null, null));
            }
        }

        var configured = entries.Select(entry => entry.PrincipalId).ToHashSet();
        entries.AddRange((await grants.ListSiteOperatorsAsync(cancellationToken).ConfigureAwait(false))
            .Where(row => !configured.Contains(row.PrincipalId))
            .Select(row => new SiteOperatorResponse(row.PrincipalId, row.DisplayName, "granted", row.GrantedAt, row.GrantedBy)));
        return Result.Success(new SiteOperatorListResponse(entries));
    }

    public async ValueTask<Result<Guid>> HandleAsync(GrantSiteOperator command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!await operators.IsOperatorAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Guid>(SiteErrors.OperatorRequired());
        }

        var target = PrincipalId.From(command.PrincipalId);
        if (await principals.FindAsync(target, cancellationToken).ConfigureAwait(false) is null)
        {
            return Result.Failure<Guid>(SiteErrors.PrincipalNotFound());
        }

        var context = session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var now = clock.GetUtcNow();
        if (await grants.AddSiteOperatorAsync(target, context.PrincipalId, now, cancellationToken).ConfigureAwait(false))
        {
            grants.AddAudit(AccessAudit.Event(context.TenantId, context.PrincipalId, "site.operator_granted", command.PrincipalId, now));
            await grants.SaveAsync(cancellationToken).ConfigureAwait(false);
        }

        return Result.Success(command.PrincipalId);
    }

    public async ValueTask<Result<Guid>> HandleAsync(RevokeSiteOperator command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!await operators.IsOperatorAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Guid>(SiteErrors.OperatorRequired());
        }

        if (options.Operators.Contains(command.PrincipalId))
        {
            return Result.Failure<Guid>(new(SiteErrors.OperatorConfiguredCode, "This operator is set in the deployment's configuration and cannot be revoked here."));
        }

        var context = session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        if (await grants.RemoveSiteOperatorAsync(PrincipalId.From(command.PrincipalId), cancellationToken).ConfigureAwait(false))
        {
            grants.AddAudit(AccessAudit.Event(context.TenantId, context.PrincipalId, "site.operator_revoked", command.PrincipalId, clock.GetUtcNow()));
            await grants.SaveAsync(cancellationToken).ConfigureAwait(false);
        }

        return Result.Success(command.PrincipalId);
    }
}
