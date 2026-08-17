using Nix.Abstractions.Templates;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Publishes a completed capture or import stage.</summary>
public readonly record struct FinalizeTemplateOperation(
    TemplateOperationId OperationId,
    IReadOnlyList<ItemId> WrittenTargetItemIds) : ICommand<TemplateId>;

/// <summary>Publishes a completed capture or import stage.</summary>
public sealed class FinalizeTemplateOperationHandler(ITemplateStagingStore stages)
    : ICommandHandler<FinalizeTemplateOperation, TemplateId>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateId>> HandleAsync(
        FinalizeTemplateOperation command,
        CancellationToken cancellationToken) =>
        stages.FinalizeOperationAsync(
            command.OperationId,
            command.WrittenTargetItemIds,
            cancellationToken);
}
