using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Domain.Primitives;
using Nix.Domain.Sites;
using Nix.Messaging;

namespace Nix.Features.Sites;

/// <summary>Attaches a custom hostname to a site.</summary>
/// <param name="SiteId">The site.</param>
/// <param name="Hostname">The hostname.</param>
/// <param name="ServeMode"><c>serve</c> (default) or <c>redirect</c> while it is not the primary.</param>
public sealed record AddSiteHostname(Guid SiteId, string Hostname, string? ServeMode) : ICommand<SiteResponse>;

/// <summary>Detaches a custom hostname, deleting its host manifest and the DNS records Nix created.</summary>
/// <param name="SiteId">The site.</param>
/// <param name="Hostname">The hostname.</param>
public sealed record RemoveSiteHostname(Guid SiteId, string Hostname) : ICommand<SiteResponse>;

/// <summary>Makes a hostname the primary, or changes how a non-primary one answers.</summary>
/// <param name="SiteId">The site.</param>
/// <param name="Hostname">The hostname.</param>
/// <param name="ServeMode">The new serve mode, if it changes.</param>
/// <param name="Primary">True to make it the primary (canonical) hostname.</param>
public sealed record UpdateSiteHostname(Guid SiteId, string Hostname, string? ServeMode, bool? Primary) : ICommand<SiteResponse>;

/// <summary>Checks a custom hostname's DNS records now (and re-creates managed ones).</summary>
/// <param name="SiteId">The site.</param>
/// <param name="Hostname">The hostname.</param>
public sealed record VerifySiteHostname(Guid SiteId, string Hostname) : ICommand<SiteResponse>;

/// <summary>Looks up a custom hostname's verification and routing records.</summary>
public sealed class SiteHostnameChecker(ISiteDnsResolver dns)
{
    /// <summary>The whole check, every lookup together, never takes longer than this.</summary>
    public static readonly TimeSpan Budget = TimeSpan.FromSeconds(5);

    /// <summary>Checks the verification TXT record, then whether the name resolves at all.</summary>
    public async Task<SiteHostnameCheck> CheckAsync(SiteHostname hostname, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(hostname);
        var token = hostname.VerificationToken
            ?? throw new InvalidOperationException("A custom hostname always has a verification token.");
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(Budget);
        try
        {
            var values = await dns.QueryAsync(SiteHostnameRules.VerificationName(hostname.Hostname), "TXT", budget.Token).ConfigureAwait(false);
            if (!values.Contains(SiteHostnameRules.VerificationValue(token), StringComparer.Ordinal))
            {
                return new SiteHostnameCheck(true, false, values.Count == 0 ? "txt_missing" : "txt_mismatch");
            }

            // A proxied or flattened name answers with addresses rather than the CNAME, so routing is
            // checked only as "resolves at all"; ownership is what the TXT record proves.
            var routed = (await dns.QueryAsync(hostname.Hostname, "A", budget.Token).ConfigureAwait(false)).Count > 0
                || (await dns.QueryAsync(hostname.Hostname, "AAAA", budget.Token).ConfigureAwait(false)).Count > 0;
            return new SiteHostnameCheck(true, true, routed ? null : "routing_missing");
        }
        catch (SiteDnsUnavailableException)
        {
            return SiteHostnameCheck.Unavailable;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return SiteHostnameCheck.Unavailable;
        }
    }
}

/// <summary>What one check did.</summary>
/// <param name="Transition">Whether serving changed.</param>
/// <param name="Reason">A short code: checked, verified, unverified, raced, hostname_gone, hostname_taken, activation_raced, expired.</param>
public sealed record SiteHostnameCheckResult(SiteHostnameTransition Transition, string Reason);

/// <summary>
/// The hostname operations every entry point shares: checking one and applying the outcome,
/// withdrawing an abandoned claim, and queueing the host-manifest writes that follow a change of
/// what is served.
/// </summary>
/// <remarks>
/// <para>
/// <b>No outside call is made under the site's row lock.</b> DNS is looked up first, from an
/// unlocked read; then the lock is taken, the hostname re-read, and the result applied only if the
/// claim and its last check are still the ones that were looked up ("raced" otherwise).
/// </para>
/// <para>
/// A change of what is served is never applied while a build or another activation of the site is
/// in flight: their host manifests were fixed before the change, and two writers of one manifest
/// could land out of order. The check is then recorded and the transition repeated next time.
/// </para>
/// </remarks>
public sealed class SiteHostnameService(
    ISiteStore sites,
    ISiteHostnameStore hostnames,
    IWorkerJobStore jobs,
    INixSessionContextAccessor session,
    SiteHostnameChecker checker,
    SiteHostnameProvisioner provisioner,
    SiteOptions options,
    SiteAudit audit,
    TimeProvider clock)
{
    /// <summary>Whether a build or an activation of the site is under way.</summary>
    public async ValueTask<bool> IsBusyAsync(Site site, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(site);
        return await sites.HasBuildInFlightAsync(site.Id, cancellationToken).ConfigureAwait(false)
            || await sites.HasActivationInFlightAsync(site.Id, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Checks one custom hostname and writes the outcome, with its audit event and, on a live site,
    /// the host-manifest activation. Saves everything itself; an activation race keeps only the
    /// check time.
    /// </summary>
    /// <param name="siteId">The site.</param>
    /// <param name="hostname">The custom hostname.</param>
    /// <param name="background">Whether the background checker acts (audited as the system actor).</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    public async Task<SiteHostnameCheckResult> CheckAsync(Guid siteId, string hostname, bool background, CancellationToken cancellationToken)
    {
        var snapshot = await FindCustomAsync(siteId, hostname, cancellationToken).ConfigureAwait(false);
        if (snapshot is null)
        {
            return new(SiteHostnameTransition.Unchanged, "hostname_gone");
        }

        var check = await checker.CheckAsync(snapshot, cancellationToken).ConfigureAwait(false);

        await sites.LockSiteAsync(siteId, cancellationToken).ConfigureAwait(false);
        var site = await sites.FindForUpdateAsync(siteId, cancellationToken).ConfigureAwait(false);
        var all = await hostnames.LoadForUpdateAsync(siteId, cancellationToken).ConfigureAwait(false);
        var host = all.SingleOrDefault(row => row.Hostname == hostname && row.Kind == SiteRules.CustomHost);
        if (site is null || host is null || host.VerificationToken != snapshot.VerificationToken || host.CheckedAt != snapshot.CheckedAt)
        {
            return new(SiteHostnameTransition.Unchanged, "raced");
        }

        var now = clock.GetUtcNow();
        await hostnames.MarkAsync(cancellationToken).ConfigureAwait(false);
        var (verifiedAt, failures) = (host.VerifiedAt, host.CheckFailures);
        var transition = SiteHostnameRules.Apply(host, check, now);
        if (transition != SiteHostnameTransition.Unchanged
            && site.Status == SiteRules.PublishedStatus
            && await IsBusyAsync(site, cancellationToken).ConfigureAwait(false))
        {
            host.VerifiedAt = verifiedAt;
            host.CheckFailures = transition == SiteHostnameTransition.Unverified ? SiteHostnameRules.MaximumCheckFailures - 1 : failures;
            transition = SiteHostnameTransition.Unchanged;
        }

        if (!await hostnames.TrySaveAsync(cancellationToken).ConfigureAwait(false))
        {
            // Another site already serves this name: the first to verify keeps it.
            await RecordCheckOnlyAsync(siteId, hostname, now, "hostname_taken", cancellationToken).ConfigureAwait(false);
            return new(SiteHostnameTransition.Unchanged, "hostname_taken");
        }

        if (transition == SiteHostnameTransition.Unchanged)
        {
            return new(transition, "checked");
        }

        var action = transition == SiteHostnameTransition.Verified ? "site.hostname_verified" : "site.hostname_unverified";
        var detail = new { hostname, error = check.Error };
        if (background)
        {
            audit.RecordSystem(site, action, null, detail);
        }
        else
        {
            audit.Record(site, action, null, detail);
        }

        await QueueActivationAsync(
            site, all, transition == SiteHostnameTransition.Unverified ? [hostname] : [], cancellationToken).ConfigureAwait(false);
        if (!await sites.TrySaveActivationAsync(cancellationToken).ConfigureAwait(false))
        {
            await hostnames.RevertToMarkAsync(cancellationToken).ConfigureAwait(false);
            await RecordCheckOnlyAsync(siteId, hostname, now, host.CheckError, cancellationToken).ConfigureAwait(false);
            return new(SiteHostnameTransition.Unchanged, "activation_raced");
        }

        return new(transition, transition == SiteHostnameTransition.Verified ? "verified" : "unverified");
    }

    /// <summary>
    /// Withdraws a claim that was never verified within <see cref="SiteHostnameRules.PendingClaimLifetime"/>:
    /// its managed records are deleted first (outside the lock), then the row, audited as the system.
    /// </summary>
    public async Task<SiteHostnameCheckResult> ExpireAsync(Guid siteId, string hostname, CancellationToken cancellationToken)
    {
        var snapshot = await FindCustomAsync(siteId, hostname, cancellationToken).ConfigureAwait(false);
        var now = clock.GetUtcNow();
        if (snapshot is null || !SiteHostnameRules.IsAbandoned(snapshot.CreatedAt, snapshot.VerifiedAt, now))
        {
            return new(SiteHostnameTransition.Unchanged, "hostname_gone");
        }

        if (await provisioner.RemoveAsync(snapshot, cancellationToken).ConfigureAwait(false) is not null)
        {
            return new(SiteHostnameTransition.Unchanged, "dns_cleanup_failed");
        }

        await sites.LockSiteAsync(siteId, cancellationToken).ConfigureAwait(false);
        var site = await sites.FindForUpdateAsync(siteId, cancellationToken).ConfigureAwait(false);
        var host = (await hostnames.LoadForUpdateAsync(siteId, cancellationToken).ConfigureAwait(false))
            .SingleOrDefault(row => row.Hostname == hostname && row.Kind == SiteRules.CustomHost);
        if (site is null || host is null || host.VerifiedAt is not null || host.VerificationToken != snapshot.VerificationToken)
        {
            return new(SiteHostnameTransition.Unchanged, "raced");
        }

        if (site.PrimaryHostname == hostname)
        {
            site.PrimaryHostname = null;
        }

        hostnames.Remove(host);
        audit.RecordSystem(site, "site.hostname_expired", new { hostname, createdAt = host.CreatedAt }, null);
        await sites.SaveAsync(cancellationToken).ConfigureAwait(false);
        return new(SiteHostnameTransition.Unchanged, "expired");
    }

    /// <summary>
    /// On a live site, queues the host-manifest writes for every served hostname plus deletes for
    /// <paramref name="retired"/>. Returns whether an activation was queued.
    /// </summary>
    public async ValueTask<bool> QueueActivationAsync(
        Site site, IReadOnlyList<SiteHostname> current, IReadOnlyCollection<string> retired, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(site);
        ArgumentNullException.ThrowIfNull(current);
        if (site.Status != SiteRules.PublishedStatus || site.LiveBuildId is not { } live)
        {
            return false;
        }

        var now = clock.GetUtcNow();
        var generation = await sites.NextGenerationAsync(site.Id, cancellationToken).ConfigureAwait(false);
        var ops = SiteHostManifests.Puts(site, live, current, generation, now, options.PublicUrl)
            .Concat(retired.Select(name => new SiteActivationOpRecord("delete", name, SiteRules.HostKey(name), null, null, 0)))
            .ToArray();
        await SiteActivations.QueueAsync(
            sites, jobs, session, site, live, SiteRules.HostnamesActivation, generation, ops, now, cancellationToken).ConfigureAwait(false);
        return true;
    }

    /// <summary>A custom hostname of the site as stored, read without any lock.</summary>
    public async ValueTask<SiteHostname?> FindCustomAsync(Guid siteId, string hostname, CancellationToken cancellationToken) =>
        (await sites.ListHostnamesAsync([siteId], cancellationToken).ConfigureAwait(false))
            .SingleOrDefault(row => row.Hostname == hostname && row.Kind == SiteRules.CustomHost);

    private async ValueTask RecordCheckOnlyAsync(Guid siteId, string hostname, DateTimeOffset now, string? error, CancellationToken cancellationToken)
    {
        if ((await hostnames.LoadForUpdateAsync(siteId, cancellationToken).ConfigureAwait(false))
            .SingleOrDefault(row => row.Hostname == hostname) is { } reloaded)
        {
            reloaded.CheckedAt = now;
            reloaded.CheckError = error;
            await sites.SaveAsync(cancellationToken).ConfigureAwait(false);
        }
    }
}

/// <summary>Handles the per-hostname commands.</summary>
/// <remarks>
/// Adding and checking call out to DNS and Cloudflare, so they authorize without the site's row
/// lock and write the hostname row only; the service takes the lock after its lookups.
/// </remarks>
public sealed class SiteHostnameHandlers(
    ISiteStore sites,
    ISiteHostnameStore hostnames,
    SiteAccess access,
    SiteOptions options,
    SiteHostnameService service,
    SiteHostnameProvisioner provisioner,
    SiteViews views,
    SiteAudit audit,
    TimeProvider clock) :
    ICommandHandler<AddSiteHostname, SiteResponse>,
    ICommandHandler<RemoveSiteHostname, SiteResponse>,
    ICommandHandler<UpdateSiteHostname, SiteResponse>,
    ICommandHandler<VerifySiteHostname, SiteResponse>
{
    public async ValueTask<Result<SiteResponse>> HandleAsync(AddSiteHostname command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var guarded = await access.AuthorizeManageAsync(command.SiteId, cancellationToken).ConfigureAwait(false);
        if (guarded.IsFailure)
        {
            return Result.Failure<SiteResponse>(guarded.Error);
        }

        var site = guarded.Value;
        var name = SiteRules.NormalizeHost(command.Hostname ?? string.Empty);
        if (!SiteRules.IsHostname(name) || (command.ServeMode is not null && !SiteHostnameRules.IsServeMode(command.ServeMode)))
        {
            return Result.Failure<SiteResponse>(SiteErrors.Invalid("Give a valid, lowercase hostname such as 'docs.example.com', and a serve mode of serve or redirect."));
        }

        if (SiteHostnamePolicy.Refusal(options, name) is { } refusal)
        {
            return Result.Failure<SiteResponse>(refusal);
        }

        var all = await sites.ListHostnamesAsync([site.Id], cancellationToken).ConfigureAwait(false);
        if (all.Any(row => row.Hostname == name))
        {
            return Result.Success(await views.ToResponseAsync(site, cancellationToken).ConfigureAwait(false));
        }

        if (all.Count(row => row.Kind == SiteRules.CustomHost) >= SiteRules.MaximumCustomHostnames)
        {
            return Result.Failure<SiteResponse>(SiteErrors.Invalid($"A site may have at most {SiteRules.MaximumCustomHostnames} custom hostnames."));
        }

        // The row first, so a claim that cannot be written never touches Cloudflare.
        var host = new SiteHostname
        {
            TenantId = site.TenantId,
            Hostname = name,
            SiteId = site.Id,
            Kind = SiteRules.CustomHost,
            CreatedAt = clock.GetUtcNow(),
            VerificationToken = SiteHostnameRules.NewToken(),
            ServeMode = command.ServeMode ?? SiteHostnameRules.ServeMode,
        };
        hostnames.Add(host);
        var managed = provisioner.Manages(name, site.WorkspaceId.Value);
        audit.Record(site, "site.hostname_added", null, new { hostname = name, serveMode = host.ServeMode, managed });
        if (!await hostnames.TrySaveAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteResponse>(new(SiteErrors.HostnameTakenCode, "That hostname was attached at the same moment. Try again."));
        }

        if (managed && await ProvisionAsync(site, host, cancellationToken).ConfigureAwait(false))
        {
            // A zone Nix manages has its records already, so it can be verified straight away.
            _ = await service.CheckAsync(site.Id, name, background: false, cancellationToken).ConfigureAwait(false);
        }

        return await RespondAsync(site.Id, cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<Result<SiteResponse>> HandleAsync(RemoveSiteHostname command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var name = SiteRules.NormalizeHost(command.Hostname ?? string.Empty);
        var guarded = await access.AuthorizeManageAsync(command.SiteId, cancellationToken).ConfigureAwait(false);
        if (guarded.IsFailure)
        {
            return Result.Failure<SiteResponse>(guarded.Error);
        }

        // Cloudflare first, outside the lock; records Nix cannot delete keep the hostname in place.
        if (await service.FindCustomAsync(command.SiteId, name, cancellationToken).ConfigureAwait(false) is { } snapshot
            && await provisioner.RemoveAsync(snapshot, cancellationToken).ConfigureAwait(false) is { } cleanup)
        {
            return Result.Failure<SiteResponse>(new(
                SiteErrors.DnsCleanupFailedCode,
                $"The DNS records Nix created for this hostname could not be deleted ({cleanup}), so it was kept. Ask the operator, then try again."));
        }

        var found = await FindAsync(command.SiteId, name, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<SiteResponse>(found.Error);
        }

        var (site, all, host) = found.Value;
        if (host.Kind != SiteRules.CustomHost)
        {
            return Result.Failure<SiteResponse>(SiteErrors.Invalid("The default hostname belongs to the slug and cannot be removed."));
        }

        var served = SiteHostnameRules.IsServed(host);
        if (served && site.Status == SiteRules.PublishedStatus && await service.IsBusyAsync(site, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteResponse>(Busy());
        }

        if (site.PrimaryHostname == host.Hostname)
        {
            site.PrimaryHostname = null;
        }

        hostnames.Remove(host);
        all.Remove(host);
        site.UpdatedAt = clock.GetUtcNow();
        audit.Record(site, "site.hostname_removed", new { hostname = host.Hostname, verified = host.VerifiedAt is not null }, null);
        return await SaveAsync(site, all, served ? [host.Hostname] : [], served, cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<Result<SiteResponse>> HandleAsync(UpdateSiteHostname command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (command.ServeMode is not null && !SiteHostnameRules.IsServeMode(command.ServeMode))
        {
            return Result.Failure<SiteResponse>(SiteErrors.Invalid("The serve mode is serve or redirect."));
        }

        var found = await FindAsync(command.SiteId, SiteRules.NormalizeHost(command.Hostname ?? string.Empty), cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<SiteResponse>(found.Error);
        }

        var (site, all, host) = found.Value;
        var before = new { primary = site.PrimaryHostname, hostname = host.Hostname, serveMode = host.ServeMode };
        if (site.Status == SiteRules.PublishedStatus && await service.IsBusyAsync(site, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteResponse>(Busy());
        }

        if (command.Primary == true)
        {
            site.PrimaryHostname = host.Kind == SiteRules.DefaultHost ? null : host.Hostname;
            host.ServeMode = SiteHostnameRules.ServeMode;
        }

        if (command.ServeMode is { } mode)
        {
            host.ServeMode = mode;
        }

        site.UpdatedAt = clock.GetUtcNow();
        audit.Record(site, "site.hostname_changed", before, new { primary = site.PrimaryHostname, hostname = host.Hostname, serveMode = host.ServeMode });
        return await SaveAsync(site, all, [], true, cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<Result<SiteResponse>> HandleAsync(VerifySiteHostname command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var guarded = await access.AuthorizeManageAsync(command.SiteId, cancellationToken).ConfigureAwait(false);
        if (guarded.IsFailure)
        {
            return Result.Failure<SiteResponse>(guarded.Error);
        }

        var site = guarded.Value;
        var name = SiteRules.NormalizeHost(command.Hostname ?? string.Empty);
        var all = await sites.ListHostnamesAsync([site.Id], cancellationToken).ConfigureAwait(false);
        if (all.SingleOrDefault(row => row.Hostname == name) is not { } host)
        {
            return Result.Failure<SiteResponse>(new(SiteErrors.HostnameNotFoundCode, "This site has no such hostname."));
        }

        if (host.Kind != SiteRules.CustomHost)
        {
            return Result.Success(await views.ToResponseAsync(site, cancellationToken).ConfigureAwait(false));
        }

        if (host.CheckedAt is { } last && clock.GetUtcNow() - last < SiteHostnameRules.CheckCooldown)
        {
            return Result.Failure<SiteResponse>(new(SiteErrors.CheckTooSoonCode, "This hostname was checked moments ago. Try again in a minute."));
        }

        if (provisioner.Manages(host.Hostname, site.WorkspaceId.Value)
            && !await ProvisionAsync(site, host, cancellationToken).ConfigureAwait(false))
        {
            return await RespondAsync(site.Id, cancellationToken).ConfigureAwait(false);
        }

        _ = await service.CheckAsync(site.Id, name, background: false, cancellationToken).ConfigureAwait(false);
        return await RespondAsync(site.Id, cancellationToken).ConfigureAwait(false);
    }

    private static NixError Busy() =>
        new(SiteErrors.BuildInProgressCode, "A build or a change of what is live is under way. Try again in a moment.");

    // Creates or repairs the managed records (no site lock held), then writes what Nix owns and
    // any error onto the hostname row, auditing every Cloudflare write. True when all is in place.
    private async ValueTask<bool> ProvisionAsync(Site site, SiteHostname snapshot, CancellationToken cancellationToken)
    {
        var outcome = await provisioner.ProvisionAsync(site, snapshot, cancellationToken).ConfigureAwait(false);
        var row = (await hostnames.LoadForUpdateAsync(site.Id, cancellationToken).ConfigureAwait(false))
            .SingleOrDefault(candidate => candidate.Hostname == snapshot.Hostname);
        if (row is null)
        {
            return false;
        }

        row.ManagedRecords = snapshot.ManagedRecords;
        if (outcome.Error is not null)
        {
            row.CheckError = outcome.Error;
            row.CheckedAt = clock.GetUtcNow();
        }

        if (outcome.Changed || outcome.Error is not null)
        {
            audit.Record(site, "site.hostname_dns_written", null, new { hostname = row.Hostname, error = outcome.Error });
        }

        await sites.SaveAsync(cancellationToken).ConfigureAwait(false);
        return outcome.Error is null;
    }

    private async ValueTask<Result<SiteResponse>> RespondAsync(Guid siteId, CancellationToken cancellationToken) =>
        await sites.FindAsync(siteId, cancellationToken).ConfigureAwait(false) is { } fresh
            ? Result.Success(await views.ToResponseAsync(fresh, cancellationToken).ConfigureAwait(false))
            : Result.Failure<SiteResponse>(SiteErrors.NotFound());

    private async ValueTask<Result<(Site Site, List<SiteHostname> All, SiteHostname Host)>> FindAsync(
        Guid siteId, string name, CancellationToken cancellationToken)
    {
        var guarded = await access.ManageAsync(siteId, cancellationToken).ConfigureAwait(false);
        if (guarded.IsFailure)
        {
            return Result.Failure<(Site, List<SiteHostname>, SiteHostname)>(guarded.Error);
        }

        var all = await hostnames.LoadForUpdateAsync(guarded.Value.Id, cancellationToken).ConfigureAwait(false);
        return all.SingleOrDefault(row => row.Hostname == name) is { } host
            ? Result.Success((guarded.Value, all, host))
            : Result.Failure<(Site, List<SiteHostname>, SiteHostname)>(new(SiteErrors.HostnameNotFoundCode, "This site has no such hostname."));
    }

    private async ValueTask<Result<SiteResponse>> SaveAsync(
        Site site, List<SiteHostname> all, IReadOnlyCollection<string> retired, bool affectsServing, CancellationToken cancellationToken)
    {
        var queued = affectsServing && await service.QueueActivationAsync(site, all, retired, cancellationToken).ConfigureAwait(false);
        if (queued ? !await sites.TrySaveActivationAsync(cancellationToken).ConfigureAwait(false) : !await hostnames.TrySaveAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteResponse>(SiteErrors.ActivationRaced());
        }

        return Result.Success(await views.ToResponseAsync(site, cancellationToken).ConfigureAwait(false));
    }
}

/// <summary>Which custom hostnames may be attached at all.</summary>
public static class SiteHostnamePolicy
{
    /// <summary>
    /// The refusal for a hostname no site may attach: the app's own host, or a name under the sites
    /// domain, which belongs to default hostnames only so no site can take a name another site's
    /// slug is entitled to.
    /// </summary>
    public static NixError? Refusal(SiteOptions options, string hostname)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(hostname);
        return hostname == options.Domain
            || hostname.EndsWith("." + options.Domain, StringComparison.Ordinal)
            || options.IsAppHost(hostname)
            ? new(SiteErrors.HostnameReservedCode, "The app's own host and hostnames under the sites domain cannot be attached.")
            : null;
    }
}
