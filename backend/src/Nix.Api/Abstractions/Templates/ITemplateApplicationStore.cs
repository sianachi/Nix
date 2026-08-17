using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;

namespace Nix.Abstractions.Templates;

/// <summary>Coordinates atomic template application.</summary>
public interface ITemplateApplicationStore
{
    public ValueTask<Result<TemplateApplicationPlan>> BeginApplicationAsync(
        TemplateId templateId,
        TemplateApplicationMode mode,
        ItemId? targetItemId,
        ItemId? parentItemId,
        string? title,
        string idempotencyKey,
        CancellationToken cancellationToken);

    public ValueTask<Result<ItemId>> FinalizeApplicationAsync(
        TemplateApplicationId applicationId,
        IReadOnlyList<ItemId> writtenBodyItemIds,
        CancellationToken cancellationToken);

    public ValueTask<Result<bool>> AbortApplicationAsync(
        TemplateApplicationId applicationId,
        CancellationToken cancellationToken);
}
