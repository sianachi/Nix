using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Removes one bounded batch of expired template stages.</summary>
public readonly record struct SweepExpiredTemplateStages(WorkspaceId WorkspaceId)
    : ICommand<TemplateStageSweepResult>;

/// <summary>Removes one bounded batch of expired template stages.</summary>
public sealed class SweepExpiredTemplateStagesHandler(ITemplateManagedStore managed)
    : ICommandHandler<SweepExpiredTemplateStages, TemplateStageSweepResult>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateStageSweepResult>> HandleAsync(
        SweepExpiredTemplateStages command,
        CancellationToken cancellationToken) =>
        managed.SweepExpiredAsync(command.WorkspaceId, cancellationToken);
}
