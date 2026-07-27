using System.Collections.Immutable;
using Nix.Core.Views;

namespace Nix.Api.Features.Views;

/// <summary>Maps between the view contract and the domain.</summary>
internal static class ViewMapping
{
    /// <summary>Maps one view onto the published shape.</summary>
    /// <param name="view">The domain view.</param>
    /// <returns>The published shape.</returns>
    internal static ViewResponse ToResponse(ViewDefinition view)
    {
        ArgumentNullException.ThrowIfNull(view);

        return new ViewResponse(
            view.Id,
            view.Name,
            ViewKinds.ToText(view.Kind),
            view.Columns,
            view.GroupBy,
            view.GroupOrder,
            view.DateProperty,
            view.SortBy,
            view.SortDescending);
    }

    /// <summary>
    /// Reads a requested view set, or says which kind it did not recognise.
    /// </summary>
    /// <param name="request">The request.</param>
    /// <param name="views">The views, when every kind was recognised.</param>
    /// <param name="unknownKind">The first unrecognised kind, when one was met.</param>
    /// <returns><see langword="true"/> when the request maps cleanly.</returns>
    internal static bool TryToDomain(
        SetViewsRequest request,
        out ImmutableArray<ViewDefinition> views,
        out string? unknownKind)
    {
        ArgumentNullException.ThrowIfNull(request);

        var mapped = ImmutableArray.CreateBuilder<ViewDefinition>(request.Views.Count);

        foreach (var view in request.Views)
        {
            if (!ViewKinds.TryParse(view.Kind, out var kind))
            {
                views = [];
                unknownKind = view.Kind;
                return false;
            }

            mapped.Add(
                new ViewDefinition(
                    view.Id,
                    view.Name,
                    kind,
                    view.Columns is null ? [] : [.. view.Columns],
                    view.GroupBy,
                    view.GroupOrder is null ? [] : [.. view.GroupOrder],
                    view.DateProperty,
                    view.SortBy,
                    view.SortDescending));
        }

        views = mapped.ToImmutable();
        unknownKind = null;
        return true;
    }
}
