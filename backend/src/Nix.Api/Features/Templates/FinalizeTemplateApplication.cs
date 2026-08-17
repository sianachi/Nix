using Nix.Abstractions.Templates;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Publishes a completed template application.</summary>
public readonly record struct FinalizeTemplateApplication(
    TemplateApplicationId ApplicationId,
    IReadOnlyList<ItemId> WrittenTargetItemIds) : ICommand<ItemId>;

/// <summary>Publishes a completed template application.</summary>
public sealed class FinalizeTemplateApplicationHandler(ITemplateApplicationStore applications)
    : ICommandHandler<FinalizeTemplateApplication, ItemId>
{
    /// <inheritdoc />
    public ValueTask<Result<ItemId>> HandleAsync(
        FinalizeTemplateApplication command,
        CancellationToken cancellationToken) =>
        applications.FinalizeApplicationAsync(
            command.ApplicationId,
            command.WrittenTargetItemIds,
            cancellationToken);
}
