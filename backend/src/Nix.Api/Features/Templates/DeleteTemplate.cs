using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Deletes a caller-managed template.</summary>
public readonly record struct DeleteTemplate(TemplateId TemplateId) : ICommand<bool>;

/// <summary>Deletes a caller-managed template.</summary>
public sealed class DeleteTemplateHandler(ITemplateCatalogStore templates)
    : ICommandHandler<DeleteTemplate, bool>
{
    /// <inheritdoc />
    public ValueTask<Result<bool>> HandleAsync(
        DeleteTemplate command,
        CancellationToken cancellationToken) =>
        templates.DeleteAsync(command.TemplateId, cancellationToken);
}
