using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Audit;
using Nix.Domain.Primitives;
using Nix.Domain.Sites;
using Nix.Messaging;

namespace Nix.Features.Sites;

/// <summary>A manager asks the operator to approve a site's first publish.</summary>
/// <param name="SiteId">The site.</param>
/// <param name="AcknowledgeDisclosure">The disclosure acknowledgement the publish itself would need.</param>
public sealed record RequestSiteApproval(Guid SiteId, bool AcknowledgeDisclosure) : ICommand<SiteResponse>;

/// <summary>The sites of the operator's tenant waiting for a decision.</summary>
public sealed record ListSiteApprovals : IQuery<Result<SiteApprovalListResponse>>;

/// <summary>An operator approves a first publish, which then runs as the manager who asked.</summary>
/// <param name="SiteId">The site.</param>
public sealed record ApproveSitePublish(Guid SiteId) : ICommand<SiteApprovalResponse>;

/// <summary>An operator rejects a first publish.</summary>
/// <param name="SiteId">The site.</param>
/// <param name="Note">Why, shown to the managers.</param>
public sealed record RejectSitePublish(Guid SiteId, string? Note) : ICommand<SiteApprovalResponse>;

/// <summary>
/// Who decides first publishes: the principals in <c>Nix:Sites:Operators</c>, or the tenant
/// administrators when that list is empty. Core decides; nothing comes from a token's claims.
/// </summary>
public sealed class SiteOperators(SiteOptions options, IPermissionResolver permissions, INixSessionContextAccessor session)
{
    /// <summary>Whether the caller is an operator.</summary>
    public async ValueTask<bool> IsOperatorAsync(CancellationToken cancellationToken)
    {
        var context = session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        return options.Operators.Count > 0
            ? options.Operators.Contains(context.PrincipalId.Value)
            : await permissions.IsTenantAdministratorAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Whether the caller is listed in <c>Nix:Sites:Operators</c>. For instance-wide data no tenant
    /// owns (backup status) the tenant-administrator fallback must not apply, so an empty list
    /// means nobody.
    /// </summary>
    public ValueTask<bool> IsInstanceOperatorAsync()
    {
        var context = session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        return ValueTask.FromResult(options.Operators.Contains(context.PrincipalId.Value));
    }
}

/// <summary>
/// First-publish approval (ADR-0063, invite-only <c>nixsites.com</c>). The operator never publishes
/// as themselves: an approval re-runs the publish in a unit of work of its own as the manager who
/// asked, so the manifest is what that manager can read and their manager rights are checked again
/// at that moment. Approvals are scoped to the operator's own tenant by row-level security.
/// </summary>
public sealed class SiteApprovalHandlers(
    ISiteStore sites,
    ISiteHostnameStore hostnames,
    SiteAccess access,
    SiteOperators operators,
    SiteOptions options,
    IIsolatedUnitOfWork isolated,
    INixSessionContextAccessor session,
    SiteViews views,
    SiteAudit audit,
    TimeProvider clock) :
    ICommandHandler<RequestSiteApproval, SiteResponse>,
    IQueryHandler<ListSiteApprovals, Result<SiteApprovalListResponse>>,
    ICommandHandler<ApproveSitePublish, SiteApprovalResponse>,
    ICommandHandler<RejectSitePublish, SiteApprovalResponse>
{
    private const string Pending = "pending";
    private const string Approved = "approved";
    private const string Rejected = "rejected";

    public async ValueTask<Result<SiteResponse>> HandleAsync(RequestSiteApproval command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var guarded = await access.ManageAsync(command.SiteId, cancellationToken).ConfigureAwait(false);
        if (guarded.IsFailure)
        {
            return Result.Failure<SiteResponse>(guarded.Error);
        }

        var site = guarded.Value;
        if (!options.RequireOperatorApproval || site.Status == SiteRules.PublishedStatus || site.ApprovalState == Approved)
        {
            return Result.Failure<SiteResponse>(new(SiteErrors.ApprovalNotNeededCode, "This site can be published without an operator's approval."));
        }

        if (site.ApprovalState == Pending)
        {
            return Result.Success(await views.ToResponseAsync(site, cancellationToken).ConfigureAwait(false));
        }

        if (!command.AcknowledgeDisclosure)
        {
            return Result.Failure<SiteResponse>(new(
                SiteErrors.DisclosureRequiredCode,
                "Once approved, this content becomes public. Search engines and web archives may keep a copy after you unpublish it; acknowledge this to continue."));
        }

        var context = session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var now = clock.GetUtcNow();
        site.ApprovalState = Pending;
        site.ApprovalRequestedBy = context.PrincipalId;
        site.ApprovalRequestedAt = now;
        site.ApprovalDecidedBy = null;
        site.ApprovalDecidedAt = null;
        site.ApprovalNote = null;
        site.UpdatedAt = now;
        audit.Record(site, "site.publish_approval_requested", null, new { state = Pending });
        await sites.SaveAsync(cancellationToken).ConfigureAwait(false);
        return Result.Success(await views.ToResponseAsync(site, cancellationToken).ConfigureAwait(false));
    }

    public async ValueTask<Result<SiteApprovalListResponse>> HandleAsync(ListSiteApprovals query, CancellationToken cancellationToken)
    {
        if (!await operators.IsOperatorAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteApprovalListResponse>(OperatorRequired());
        }

        var pending = await hostnames.ListPendingApprovalsAsync(cancellationToken).ConfigureAwait(false);
        var hosts = (await sites.ListHostnamesAsync([.. pending.Select(site => site.Id)], cancellationToken).ConfigureAwait(false))
            .ToLookup(hostname => hostname.SiteId);
        return Result.Success(new SiteApprovalListResponse(
            [.. pending.Select(site => ToApproval(site, [.. hosts[site.Id].Select(hostname => hostname.Hostname)], null))]));
    }

    public async ValueTask<Result<SiteApprovalResponse>> HandleAsync(ApproveSitePublish command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!await operators.IsOperatorAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteApprovalResponse>(OperatorRequired());
        }

        // Read without the row lock: the publish below takes it in its own transaction.
        var site = await sites.FindAsync(command.SiteId, cancellationToken).ConfigureAwait(false);
        if (site is null)
        {
            return Result.Failure<SiteApprovalResponse>(SiteErrors.NotFound());
        }

        if (site.ApprovalState != Pending || site.ApprovalRequestedBy is not { } requester || site.ApprovalRequestedAt is not { } requestedAt)
        {
            return Result.Failure<SiteApprovalResponse>(NoneWaiting());
        }

        var operatorId = (session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.")).PrincipalId;
        var outcome = await isolated.RunAsync(
            new NixSessionContext(site.TenantId, site.WorkspaceId, requester),
            async (provider, token) =>
            {
                var store = provider.GetRequiredService<ISiteStore>();
                if (!await provider.GetRequiredService<IPrincipalStatusChecker>().IsActiveAsync(requester, token).ConfigureAwait(false))
                {
                    return new IsolatedOutcome<Result<SiteBuildResponse>>(
                        Result.Failure<SiteBuildResponse>(PublishFailed(SiteErrors.ManagerRequiredCode)), false);
                }

                await store.LockSiteAsync(site.Id, token).ConfigureAwait(false);
                var tracked = await store.FindForUpdateAsync(site.Id, token).ConfigureAwait(false);
                if (tracked is null || tracked.ApprovalState != Pending || tracked.ApprovalRequestedAt != requestedAt)
                {
                    return new IsolatedOutcome<Result<SiteBuildResponse>>(Result.Failure<SiteBuildResponse>(NoneWaiting()), false);
                }

                var now = clock.GetUtcNow();
                tracked.ApprovalState = Approved;
                tracked.ApprovalDecidedBy = operatorId;
                tracked.ApprovalDecidedAt = now;
                store.AddAudit(Decision(tracked, operatorId, "site.publish_approved", now));
                await store.SaveAsync(token).ConfigureAwait(false);
                var published = await provider.GetRequiredService<NixDispatcher>()
                    .SendAsync<PublishSite, SiteBuildResponse>(
                        new PublishSite(
                            site.Id,
                            "approval:" + site.Id.ToString("N") + ":" + requestedAt.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture),
                            RefreshPaths: false,
                            AcknowledgeDisclosure: true,
                            "manual"),
                        token)
                    .ConfigureAwait(false);
                return new IsolatedOutcome<Result<SiteBuildResponse>>(
                    published.IsSuccess ? published : Result.Failure<SiteBuildResponse>(PublishFailed(published.Error.Code)),
                    published.IsSuccess);
            },
            cancellationToken).ConfigureAwait(false);
        if (outcome.IsFailure)
        {
            return Result.Failure<SiteApprovalResponse>(outcome.Error);
        }

        // This request's own snapshot predates the publish's commit, so the outcome is shown as written.
        site.ApprovalState = Approved;
        site.ApprovalDecidedBy = operatorId;
        site.ApprovalDecidedAt = clock.GetUtcNow();
        return Result.Success(ToApproval(site, await HostsAsync(site.Id, cancellationToken).ConfigureAwait(false), outcome.Value));
    }

    public async ValueTask<Result<SiteApprovalResponse>> HandleAsync(RejectSitePublish command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!await operators.IsOperatorAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteApprovalResponse>(OperatorRequired());
        }

        var note = command.Note?.Trim();
        if (note is { Length: > 500 } || (note is not null && note.Any(char.IsControl)))
        {
            return Result.Failure<SiteApprovalResponse>(SiteErrors.Invalid("The note may be at most 500 characters on one line."));
        }

        await sites.LockSiteAsync(command.SiteId, cancellationToken).ConfigureAwait(false);
        var site = await sites.FindForUpdateAsync(command.SiteId, cancellationToken).ConfigureAwait(false);
        if (site is null)
        {
            return Result.Failure<SiteApprovalResponse>(SiteErrors.NotFound());
        }

        if (site.ApprovalState != Pending)
        {
            return Result.Failure<SiteApprovalResponse>(NoneWaiting());
        }

        var now = clock.GetUtcNow();
        var operatorId = (session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.")).PrincipalId;
        site.ApprovalState = Rejected;
        site.ApprovalDecidedBy = operatorId;
        site.ApprovalDecidedAt = now;
        site.ApprovalNote = string.IsNullOrEmpty(note) ? null : note;
        site.UpdatedAt = now;
        audit.Record(site, "site.publish_rejected", new { state = Pending }, new { state = Rejected, note = site.ApprovalNote });
        await sites.SaveAsync(cancellationToken).ConfigureAwait(false);
        return Result.Success(ToApproval(site, await HostsAsync(site.Id, cancellationToken).ConfigureAwait(false), null));
    }

    private static NixError OperatorRequired() =>
        new(SiteErrors.OperatorRequiredCode, "Only an operator of this deployment may decide first publishes.");

    private static NixError NoneWaiting() =>
        new(SiteErrors.NoApprovalPendingCode, "This site has no publish waiting for approval.");

    private static NixError PublishFailed(string code) =>
        new(SiteErrors.ApprovalPendingCode, "The approved publish could not start (" + code + "); the request is still waiting. Ask the manager, or reject it.");

    private static AuditEvent Decision(Site site, Nix.Domain.Identity.PrincipalId operatorId, string action, DateTimeOffset now) => new()
    {
        Id = AuditEventId.Create(),
        TenantId = site.TenantId,
        WorkspaceId = site.WorkspaceId,
        ActorId = operatorId,
        OnBehalfOf = null,
        Action = action,
        SubjectId = site.Id,
        SubjectType = "site",
        Before = JsonSerializer.Serialize(new { state = Pending }),
        After = JsonSerializer.Serialize(new { state = site.ApprovalState, requestedBy = site.ApprovalRequestedBy?.Value }),
        ActorIp = null,
        OccurredAt = now,
    };

    private async ValueTask<string[]> HostsAsync(Guid siteId, CancellationToken cancellationToken) =>
        [.. (await sites.ListHostnamesAsync([siteId], cancellationToken).ConfigureAwait(false)).Select(hostname => hostname.Hostname)];

    private static SiteApprovalResponse ToApproval(Site site, IReadOnlyList<string> hosts, SiteBuildResponse? build) => new(
        site.Id,
        site.WorkspaceId.Value,
        site.Slug,
        SiteViews.ReadSettings(site).Name,
        hosts,
        site.ApprovalRequestedBy?.Value ?? Guid.Empty,
        new SiteApprovalDto(site.ApprovalState ?? Pending, site.ApprovalRequestedAt ?? site.UpdatedAt, site.ApprovalDecidedAt, site.ApprovalNote),
        build);
}
