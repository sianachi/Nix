using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Atomically publishes a managed template directory snapshot.</summary>
public readonly record struct FinalizeManagedTemplates(
    WorkspaceId WorkspaceId,
    IReadOnlyList<ManagedTemplateFinalization> Imports,
    IReadOnlyList<string> ActiveStableKeys) : ICommand<ManagedTemplateBatchResult>;

/// <summary>Atomically publishes a managed template directory snapshot.</summary>
public sealed class FinalizeManagedTemplatesHandler(ITemplateManagedStore managed)
    : ICommandHandler<FinalizeManagedTemplates, ManagedTemplateBatchResult>
{
    /// <inheritdoc />
    public ValueTask<Result<ManagedTemplateBatchResult>> HandleAsync(
        FinalizeManagedTemplates command,
        CancellationToken cancellationToken) =>
        managed.FinalizeManagedBatchAsync(
            command.WorkspaceId,
            command.Imports,
            command.ActiveStableKeys,
            cancellationToken);
}
