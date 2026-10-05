using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Templates;
using Nix.Domain.Views;

namespace Nix.Persistence.Templates;

public sealed partial class TemplateStore
{
    /// <summary>Calculates server-owned additions before an application begins.</summary>
    public ValueTask<Result<TemplatePreflight>> PreflightAsync(
        TemplateId templateId,
        TemplateApplicationMode mode,
        ItemId? targetItemId,
        ItemId? parentItemId,
        CancellationToken cancellationToken) =>
        PreflightAsync(
            templateId,
            mode,
            targetItemId,
            parentItemId,
            null,
            null,
            null,
            cancellationToken);

    /// <summary>Preflights the same initialized envelope the application path will stage.</summary>
    public async ValueTask<Result<TemplatePreflight>> PreflightAsync(
        TemplateId templateId,
        TemplateApplicationMode mode,
        ItemId? targetItemId,
        ItemId? parentItemId,
        string? title,
        IReadOnlyDictionary<string, string>? inputs,
        int? expectedRevision,
        CancellationToken cancellationToken)
    {
        var template = await ActiveTemplateAsync(templateId, cancellationToken).ConfigureAwait(false);
        if (template is null
            || !await _permissions.CanReadWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplatePreflight>(TemplateErrors.NotFound("No such template is visible."));
        }

        var source = await ActiveTreeAsync(template, cancellationToken).ConfigureAwait(false);
        if (source.Count == 0)
        {
            return Result.Failure<TemplatePreflight>(TemplateErrors.Invalid("The template has no active root."));
        }

        var canApply = await _permissions.CanWriteWorkspaceAsync(template.WorkspaceId, cancellationToken)
            .ConfigureAwait(false);
        var templateConflict = _validator.ValidateTemplateTree(source, tolerateViewDrift: true);
        var existingBySource = new Dictionary<Guid, ItemId>();
        var conflicts = new List<string>();
        if (templateConflict is not null)
        {
            conflicts.Add(templateConflict);
        }
        var fieldAdditions = 0;
        var viewAdditions = 0;
        var itemAdditions = source.Count;

        if (mode == TemplateApplicationMode.Create)
        {
            if (targetItemId is not null)
            {
                return Result.Failure<TemplatePreflight>(TemplateErrors.Invalid(
                    "A create preflight cannot include a merge target."));
            }

            if (parentItemId is { } parent
                && (await RegularItemAsync(parent, cancellationToken).ConfigureAwait(false) is not { } parentItem
                    || parentItem.WorkspaceId != template.WorkspaceId))
            {
                return Result.Failure<TemplatePreflight>(TemplateErrors.NotFound("No such destination is visible."));
            }

            var root = source[0];
            fieldAdditions = PropertySchemaJson.Read(root.Schema).Properties.Length;
            viewAdditions = ViewDefinitionsJson.Read(root.Views).Views.Length;
        }
        else
        {
            if (parentItemId is not null)
            {
                return Result.Failure<TemplatePreflight>(TemplateErrors.Invalid(
                    "A merge preflight cannot include a create parent."));
            }

            if (targetItemId is not { } targetId
                || await RegularItemAsync(targetId, cancellationToken).ConfigureAwait(false) is not { } target
                || target.WorkspaceId != template.WorkspaceId)
            {
                return Result.Failure<TemplatePreflight>(TemplateErrors.NotFound("No such target is visible."));
            }

            existingBySource[source[0].TemplateSourceId!.Value] = target.Id;
            var effectiveTargetSchema = await _schemas.ResolveForItemAsync(targetId, cancellationToken).ConfigureAwait(false);
            var merge = _mergePlanner.Plan(
                target.Schema,
                source[0].Schema,
                target.Views,
                source[0].Views,
                effectiveTargetSchema);
            fieldAdditions = merge.FieldAdditions;
            viewAdditions = merge.ViewAdditions;
            var prior = await PriorTargetMapAsync(
                templateId,
                targetId,
                template.WorkspaceId,
                source.Select(item => item.TemplateSourceId!.Value).ToArray(),
                cancellationToken).ConfigureAwait(false);
            if (prior.IsFailure)
            {
                conflicts.Add(prior.Error.Message);
                return Result.Success(new TemplatePreflight(
                    templateId,
                    mode,
                    fieldAdditions,
                    viewAdditions,
                    0,
                    conflicts,
                    false));
            }

            foreach (var pair in prior.Value)
            {
                existingBySource[pair.Key] = pair.Value;
            }

            var priorSources = prior.Value.Keys.ToHashSet();
            itemAdditions = source.Skip(1).Count(item => !priorSources.Contains(item.TemplateSourceId!.Value));
            conflicts.AddRange(merge.Conflicts);
        }

        var prepared = await PrepareApplicationAsync(
            template,
            source,
            mode,
            targetItemId,
            parentItemId,
            title,
            inputs,
            existingBySource,
            expectedRevision,
            cancellationToken).ConfigureAwait(false);
        if (prepared.IsFailure)
        {
            return Result.Failure<TemplatePreflight>(prepared.Error);
        }

        return Result.Success(new TemplatePreflight(
            templateId,
            mode,
            fieldAdditions,
            viewAdditions,
            itemAdditions,
            conflicts,
            canApply && conflicts.Count == 0,
            prepared.Value.Resolution,
            prepared.Value.Preview));
    }
}
