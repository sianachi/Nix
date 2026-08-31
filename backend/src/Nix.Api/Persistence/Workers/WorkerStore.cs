using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions.Workers;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;

namespace Nix.Persistence.Workers;

public sealed class WorkerStore(NixDbContext database) : IWorkerJobStore, IWorkerOutboxStore
{
    public async ValueTask<WorkerJobRecord> CreateAsync(
        TenantId tenantId,
        PrincipalId actorId,
        WorkspaceId? workspaceId,
        string kind,
        string idempotencyKey,
        string payload,
        CancellationToken cancellationToken)
    {
        var existing = await database.WorkerJobs.AsNoTracking()
            .SingleOrDefaultAsync(job => job.TenantId == tenantId && job.ActorId == actorId && job.IdempotencyKey == idempotencyKey, cancellationToken)
            .ConfigureAwait(false);
        if (existing is not null)
        {
            return ToRecord(existing);
        }
        var now = DateTimeOffset.UtcNow;
        var job = new WorkerJob
        {
            Id = WorkerJobId.Create(),
            TenantId = tenantId,
            WorkspaceId = workspaceId,
            ActorId = actorId,
            Kind = kind,
            IdempotencyKey = idempotencyKey,
            Payload = payload,
            Status = "queued",
            CreatedAt = now,
            UpdatedAt = now,
        };
        database.WorkerJobs.Add(job);
        database.WorkerOutboxEvents.Add(new WorkerOutboxEvent
        {
            Id = WorkerOutboxEventId.Create(),
            TenantId = tenantId,
            WorkspaceId = workspaceId,
            Kind = "worker.command",
            Payload = JsonSerializer.Serialize(new WorkerCommandReference(job.Id.Value, kind)),
            AvailableAt = now,
        });
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return ToRecord(job);
    }

    public async ValueTask<WorkerJobRecord?> GetAsync(TenantId tenantId, PrincipalId actorId, Guid jobId, CancellationToken cancellationToken)
    {
        var job = await database.WorkerJobs.AsNoTracking()
            .SingleOrDefaultAsync(item => item.TenantId == tenantId && item.ActorId == actorId && item.Id == WorkerJobId.From(jobId), cancellationToken)
            .ConfigureAwait(false);
        return job is null ? null : ToRecord(job);
    }

    public async ValueTask<bool> CancelAsync(TenantId tenantId, PrincipalId actorId, Guid jobId, CancellationToken cancellationToken)
    {
        var job = await database.WorkerJobs.AsTracking()
            .SingleOrDefaultAsync(candidate =>
                candidate.TenantId == tenantId
                && candidate.ActorId == actorId
                && candidate.Id == WorkerJobId.From(jobId), cancellationToken)
            .ConfigureAwait(false);
        if (job is null)
        {
            return false;
        }

        if (job.Status is "completed" or "failed" or "cancelled")
        {
            return true;
        }

        var now = DateTimeOffset.UtcNow;
        job.CancellationRequested = true;
        job.UpdatedAt = now;
        if (job.Status == "queued")
        {
            job.Status = "cancelled";
            job.CompletedAt = now;
        }
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return true;
    }

    public async ValueTask<IReadOnlyList<WorkerJobRecord>> LeaseAsync(TenantId tenantId, string owner, string? kind, int limit, int leaseSeconds, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var leaseUntil = now.AddSeconds(leaseSeconds);
        var query = database.WorkerJobs.Where(job => job.TenantId == tenantId && (job.Status == "queued" || (job.Status == "running" && job.LeaseUntil < now)) && !job.CancellationRequested);
        if (!string.IsNullOrWhiteSpace(kind))
        {
            query = query.Where(job => job.Kind == kind);
        }
        var jobs = await query.OrderBy(job => job.CreatedAt).Take(limit).ToListAsync(cancellationToken).ConfigureAwait(false);
        foreach (var job in jobs)
        {
            job.Status = "running";
            job.Attempts++;
            job.LeaseOwner = owner;
            job.LeaseUntil = leaseUntil;
            job.StartedAt ??= now;
            job.UpdatedAt = now;
        }
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return jobs.Select(ToRecord).ToArray();
    }

    public async ValueTask<bool> CompleteAsync(TenantId tenantId, Guid jobId, bool succeeded, string? result, string? errorCode, string? errorDetail, CancellationToken cancellationToken)
    {
        var job = await database.WorkerJobs.SingleOrDefaultAsync(item => item.TenantId == tenantId && item.Id == WorkerJobId.From(jobId), cancellationToken).ConfigureAwait(false);
        if (job is null)
        {
            return false;
        }
        var now = DateTimeOffset.UtcNow;
        job.Status = succeeded ? "completed" : "failed";
        job.Result = result;
        job.ErrorCode = errorCode;
        job.ErrorDetail = errorDetail;
        job.LeaseOwner = null;
        job.LeaseUntil = null;
        job.CompletedAt = now;
        job.UpdatedAt = now;
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return true;
    }

    async ValueTask<IReadOnlyList<WorkerOutboxRecord>> IWorkerOutboxStore.LeaseAsync(TenantId tenantId, string owner, string? kind, int limit, int leaseSeconds, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var leaseUntil = now.AddSeconds(leaseSeconds);
        var query = database.WorkerOutboxEvents.Where(evt => evt.TenantId == tenantId && evt.ProcessedAt == null && evt.AvailableAt <= now && (evt.LeaseUntil == null || evt.LeaseUntil < now));
        if (!string.IsNullOrWhiteSpace(kind))
        {
            query = query.Where(evt => evt.Kind == kind);
        }
        var events = await query.OrderBy(evt => evt.AvailableAt).Take(limit).ToListAsync(cancellationToken).ConfigureAwait(false);
        foreach (var evt in events)
        {
            evt.Attempts++;
            evt.LeaseOwner = owner;
            evt.LeaseUntil = leaseUntil;
        }
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return events.Select(ToRecord).ToArray();
    }

    public async ValueTask<bool> AcknowledgeAsync(TenantId tenantId, Guid eventId, CancellationToken cancellationToken) =>
        await database.WorkerOutboxEvents
            .Where(evt => evt.TenantId == tenantId && evt.Id == WorkerOutboxEventId.From(eventId))
            .ExecuteUpdateAsync(setters => setters
                .SetProperty(evt => evt.ProcessedAt, DateTimeOffset.UtcNow)
                .SetProperty(evt => evt.LeaseOwner, (string?)null)
                .SetProperty(evt => evt.LeaseUntil, (DateTimeOffset?)null), cancellationToken)
            .ConfigureAwait(false) != 0;

    public async ValueTask<bool> FailAsync(TenantId tenantId, Guid eventId, string failureDetail, CancellationToken cancellationToken)
    {
        var evt = await database.WorkerOutboxEvents.SingleOrDefaultAsync(item => item.TenantId == tenantId && item.Id == WorkerOutboxEventId.From(eventId), cancellationToken).ConfigureAwait(false);
        if (evt is null)
        {
            return false;
        }
        evt.LastError = failureDetail;
        evt.LeaseOwner = null;
        evt.LeaseUntil = null;
        evt.AvailableAt = DateTimeOffset.UtcNow.AddSeconds(Math.Min(Math.Max(evt.Attempts * 5, 5), 300));
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return true;
    }

    private static WorkerJobRecord ToRecord(WorkerJob job) => new(job.Id.Value, job.Kind, job.Status, job.Payload, job.Result, job.ErrorCode, job.ErrorDetail, job.Attempts, job.CancellationRequested, job.CreatedAt, job.CompletedAt);
    private static WorkerOutboxRecord ToRecord(WorkerOutboxEvent evt) => new(evt.Id.Value, evt.Kind, evt.Payload, evt.Attempts, evt.AvailableAt);

    private sealed record WorkerCommandReference(Guid JobId, string Kind);
}
