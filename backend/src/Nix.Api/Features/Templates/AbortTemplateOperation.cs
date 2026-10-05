using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Aborts a capture or import stage.</summary>
public readonly record struct AbortTemplateOperation(TemplateOperationId OperationId) : ICommand<bool>;

/// <summary>Aborts a capture or import stage.</summary>
public sealed class AbortTemplateOperationHandler(ITemplateStagingStore stages)
    : ICommandHandler<AbortTemplateOperation, bool>
{
    /// <inheritdoc />
    public ValueTask<Result<bool>> HandleAsync(
        AbortTemplateOperation command,
        CancellationToken cancellationToken) =>
        stages.AbortOperationAsync(command.OperationId, cancellationToken);
}
