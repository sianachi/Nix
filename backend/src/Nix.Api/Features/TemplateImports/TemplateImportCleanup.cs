using Nix.Abstractions;
using Nix.Abstractions.Importing;
using Nix.Abstractions.Workers;
using Nix.Domain.Tenancy;

namespace Nix.Features.TemplateImports;

/// <summary>Queues object cleanup for a template import that was cancelled or rejected.</summary>
internal static class TemplateImportCleanup
{
    internal static async Task QueueAsync(
        DocumentImportCleanupRecord cleanup,
        Guid importId,
        HttpContext context,
        IWorkerJobStore jobs,
        NixSessionContext scoped,
        DateTimeOffset notBefore) =>
        await ObjectCleanupJobs.QueueBatchedAsync(
            jobs,
            scoped.TenantId,
            scoped.PrincipalId,
            WorkspaceId.From(cleanup.WorkspaceId),
            "template-import",
            importId,
            notBefore,
            cleanup.ObjectKeys,
            context.RequestAborted).ConfigureAwait(false);
}
