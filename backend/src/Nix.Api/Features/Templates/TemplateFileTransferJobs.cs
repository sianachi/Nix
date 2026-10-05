using System.Text.Json;
using Nix.Abstractions;
using Nix.Abstractions.Templates;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Templates;
using Nix.Domain.Workers;
using Nix.Features.Internal;

namespace Nix.Features.Templates;

internal sealed record TemplateFileTransferJobReceipt(Guid? JobId, bool Pending);

internal static class TemplateFileTransferJobs
{
    internal static async ValueTask<TemplateFileTransferJobReceipt> EnsureAsync(
        string ownerKind,
        Guid ownerId,
        bool hasFileItems,
        ITemplateFileTransferStore transfers,
        IWorkerJobStore jobs,
        INixSessionContextAccessor session,
        CancellationToken cancellationToken)
    {
        if (!hasFileItems)
        {
            return new TemplateFileTransferJobReceipt(null, false);
        }

        var workspaceId = await transfers.GetCopyWorkspaceAsync(ownerKind, ownerId, cancellationToken)
            .ConfigureAwait(false);
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        if (workspaceId is null)
        {
            throw new InvalidOperationException("A staged file item has no durable file-copy mapping.");
        }

        var payload = new TemplateFileTransferJobPayload(ownerKind, ownerId);
        var job = await jobs.CreateAsync(
            scoped.TenantId,
            scoped.PrincipalId,
            workspaceId,
            "template.files.copy",
            $"template.files.copy:{ownerKind}:{ownerId:D}",
            JsonSerializer.Serialize(payload, TemplateFileTransfersJsonContext.Default.TemplateFileTransferJobPayload),
            cancellationToken).ConfigureAwait(false);
        return new TemplateFileTransferJobReceipt(job.Id, job.Status != "completed");
    }
}
