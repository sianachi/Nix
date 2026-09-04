using System.Collections.Immutable;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Templates;
using Nix.Domain.Audit;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Templates;

public sealed partial class TemplateStore
{
    /// <summary>Calculates server-owned additions before an application begins.</summary>
    public async ValueTask<Result<TemplatePreflight>> PreflightAsync(
        TemplateId templateId,
        TemplateApplicationMode mode,
        ItemId? targetItemId,
        ItemId? parentItemId,
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
        if (ContainsFileItems(source))
        {
            return Result.Failure<TemplatePreflight>(TemplateErrors.FileAttachmentsUnsupported());
        }
        var canApply = await _permissions.CanWriteWorkspaceAsync(template.WorkspaceId, cancellationToken)
            .ConfigureAwait(false);
        // Preflighting an application of a captured template: the source came from a workspace and
        // is tolerated the same way it was at capture, so a template that saved can also be applied.
        var templateConflict = _validator.ValidateTemplateTree(source, tolerateViewDrift: true);

        if (mode == TemplateApplicationMode.Create)
        {
            if (parentItemId is { } parent
                && (await RegularItemAsync(parent, cancellationToken).ConfigureAwait(false) is not { } parentItem
                    || parentItem.WorkspaceId != template.WorkspaceId))
            {
                return Result.Failure<TemplatePreflight>(TemplateErrors.NotFound("No such destination is visible."));
            }

            var root = source[0];
            IReadOnlyList<string> createConflicts = templateConflict is null ? [] : [templateConflict];
            return Result.Success(new TemplatePreflight(
                templateId,
                mode,
                PropertySchemaJson.Read(root.Schema).Properties.Length,
                ViewDefinitionsJson.Read(root.Views).Views.Length,
                source.Count,
                createConflicts,
                canApply && createConflicts.Count == 0));
        }

        if (targetItemId is not { } targetId
            || await RegularItemAsync(targetId, cancellationToken).ConfigureAwait(false) is not { } target
            || target.WorkspaceId != template.WorkspaceId)
        {
            return Result.Failure<TemplatePreflight>(TemplateErrors.NotFound("No such target is visible."));
        }

        var effectiveTargetSchema = await _schemas.ResolveForItemAsync(targetId, cancellationToken).ConfigureAwait(false);
        var merge = _mergePlanner.Plan(
            target.Schema,
            source[0].Schema,
            target.Views,
            source[0].Views,
            effectiveTargetSchema);
        var prior = await PriorTargetMapAsync(
            templateId,
            targetId,
            template.WorkspaceId,
            source.Select(item => item.TemplateSourceId!.Value).ToArray(),
            cancellationToken).ConfigureAwait(false);
        var conflicts = merge.Conflicts.ToList();
        if (templateConflict is not null)
        {
            conflicts.Add(templateConflict);
        }
        if (prior.IsFailure)
        {
            conflicts.Add(prior.Error.Message);
        }
        var priorSources = prior.IsSuccess ? prior.Value.Keys.ToHashSet() : [];
        var itemAdditions = source.Skip(1).Count(item => !priorSources.Contains(item.TemplateSourceId!.Value));
        return Result.Success(new TemplatePreflight(
            templateId,
            mode,
            merge.FieldAdditions,
            merge.ViewAdditions,
            itemAdditions,
            conflicts,
            canApply && conflicts.Count == 0));
    }

}
