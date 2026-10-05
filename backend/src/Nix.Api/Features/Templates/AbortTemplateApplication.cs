using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Aborts a template application stage.</summary>
public readonly record struct AbortTemplateApplication(TemplateApplicationId ApplicationId) : ICommand<bool>;

/// <summary>Aborts a template application stage.</summary>
public sealed class AbortTemplateApplicationHandler(ITemplateApplicationStore applications)
    : ICommandHandler<AbortTemplateApplication, bool>
{
    /// <inheritdoc />
    public ValueTask<Result<bool>> HandleAsync(
        AbortTemplateApplication command,
        CancellationToken cancellationToken) =>
        applications.AbortApplicationAsync(command.ApplicationId, cancellationToken);
}
