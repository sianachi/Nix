using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Scheduling;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Reconciles derived <c>scheduled_trigger</c> rows against every registered
/// <see cref="ITriggerSource"/>, every 60 seconds, 48 hours ahead (ADR-0051 section 2). Idempotent
/// by construction: replanning the same desired set upserts the rows their dedupe keys already
/// name and cancels only what a source no longer produces.
/// </summary>
public sealed class TriggerPlanner(
    IServiceScopeFactory scopes,
    TimeProvider clock,
    ILogger<TriggerPlanner>? logger = null) : BackgroundService
{
    private static readonly TimeSpan PlanInterval = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan PlanWindowSpan = TimeSpan.FromHours(48);
    private static readonly TimeSpan FailureDelay = TimeSpan.FromSeconds(5);

    private readonly ILogger<TriggerPlanner> logger = logger ?? NullLogger<TriggerPlanner>.Instance;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await PlanOnceAsync(stoppingToken).ConfigureAwait(false);
                await Task.Delay(PlanInterval, clock, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
#pragma warning disable CA1031 // Justification: planning is durable and must retry after any transient database failure.
            catch (Exception exception)
            {
                TriggerPlannerLog.Failed(logger, exception);
                await Task.Delay(FailureDelay, clock, stoppingToken).ConfigureAwait(false);
            }
#pragma warning restore CA1031
        }
    }

    /// <summary>Runs one full planning pass over every registered source; exposed for tests.</summary>
    public async Task PlanOnceAsync(CancellationToken cancellationToken)
    {
        var now = clock.GetUtcNow();
        var window = new PlanWindow(now, now + PlanWindowSpan);

        // Sources are resolved from a short-lived scope of their own, never held by this
        // singleton: a source is free to depend on scoped services (a store, a session-less
        // reader), and PlanAsync itself runs before any recipient's own session is established -
        // no source registered in this lane needs one to plan.
        var planningScope = scopes.CreateAsyncScope();
        List<(string Name, TriggerKind Kind, IReadOnlyList<DesiredTrigger> Desired)> plans;
        await using (planningScope.ConfigureAwait(false))
        {
            var registered = planningScope.ServiceProvider.GetServices<ITriggerSource>().ToArray();
            TriggerSourceNames.RequireUnique(registered);
            plans = new List<(string Name, TriggerKind Kind, IReadOnlyList<DesiredTrigger> Desired)>(registered.Length);
            foreach (var source in registered)
            {
                // One source's failure - a row so malformed its own defenses could not save it,
                // or any other exception - must not take every other source's planning down with
                // it. Every source here plans across every tenant at once; a single bad row in
                // one tenant aborting the whole pass would turn into an outage for every tenant,
                // for every kind of reminder, not just the one row that was wrong.
                IReadOnlyList<DesiredTrigger> desired;
                try
                {
                    desired = await source.PlanAsync(window, cancellationToken).ConfigureAwait(false);
                }
#pragma warning disable CA1031 // Justification: isolating one source's failure from every other source's planning is the point.
                catch (Exception exception)
                {
                    TriggerPlannerLog.SourceFailed(logger, source.Name, exception);
                    continue;
                }
#pragma warning restore CA1031

                plans.Add((source.Name, source.Kind, desired));
            }
        }

        foreach (var (name, kind, desired) in plans)
        {
            foreach (var group in desired.GroupBy(trigger => (trigger.TenantId, trigger.WorkspaceId, trigger.PrincipalId)))
            {
                await ReconcileOwnerAsync(name, kind, group.Key, group.ToArray(), window, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private async Task ReconcileOwnerAsync(
        string source,
        TriggerKind kind,
        (Nix.Domain.Tenancy.TenantId TenantId, Nix.Domain.Tenancy.WorkspaceId? WorkspaceId, Nix.Domain.Identity.PrincipalId PrincipalId) owner,
        IReadOnlyList<DesiredTrigger> desired,
        PlanWindow window,
        CancellationToken cancellationToken)
    {
        var scope = scopes.CreateAsyncScope();
        await using (scope.ConfigureAwait(false))
        {
            var provider = scope.ServiceProvider;
            provider.GetRequiredService<ScopedNixSessionContextAccessor>().Set(new NixSessionContext(
                owner.TenantId, owner.WorkspaceId, owner.PrincipalId));
            var database = provider.GetRequiredService<NixDbContext>();
            var transaction = await database.Database.BeginTransactionAsync(cancellationToken).ConfigureAwait(false);
            await using (transaction.ConfigureAwait(false))
            {
                var store = provider.GetRequiredService<IScheduledTriggerStore>();
                foreach (var trigger in desired)
                {
                    await store.UpsertPendingAsync(
                        trigger.TenantId,
                        trigger.WorkspaceId,
                        trigger.PrincipalId,
                        kind,
                        source,
                        trigger.SourceItemId,
                        trigger.RuleId,
                        trigger.FireAt,
                        trigger.DedupeKey,
                        cancellationToken).ConfigureAwait(false);
                }

                await store.CancelStaleAsync(
                    owner.TenantId,
                    owner.WorkspaceId,
                    owner.PrincipalId,
                    kind,
                    source,
                    window.Start,
                    window.End,
                    desired.Select(trigger => trigger.DedupeKey).ToArray(),
                    cancellationToken).ConfigureAwait(false);

                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            }
        }
    }
}

internal static partial class TriggerPlannerLog
{
    [LoggerMessage(5310, LogLevel.Error, "Trigger planning failed and will retry")]
    internal static partial void Failed(ILogger logger, Exception exception);

    [LoggerMessage(5311, LogLevel.Error, "Trigger source {SourceName} failed to plan; every other source still ran")]
    internal static partial void SourceFailed(ILogger logger, string sourceName, Exception exception);
}
