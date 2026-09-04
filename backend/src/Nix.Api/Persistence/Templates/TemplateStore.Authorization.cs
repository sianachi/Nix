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
    /// <summary>Authorizes every item mapping and identifies required body targets in one worker-owned import stage.</summary>
    public async ValueTask<Result<TemplateOperationWriteAuthorization>> AuthorizeOperationWritesAsync(
        TemplateOperationId operationId,
        CancellationToken cancellationToken)
    {
        var operation = await _database.TemplateOperations
            .AsNoTracking()
            .FirstOrDefaultAsync(candidate => candidate.Id == operationId, cancellationToken)
            .ConfigureAwait(false);
        if (operation is null
            || operation.ActorId != Context.PrincipalId
            || operation.Kind != TemplateOperationKind.Import
            || operation.State != TemplateOperationState.Provisioning
            || operation.ExpiresAt <= _clock.GetUtcNow()
            || !await _permissions.CanWriteWorkspaceAsync(operation.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateOperationWriteAuthorization>(
                TemplateErrors.NotFound("No such template import stage is visible."));
        }

        var mappings = await _database.TemplateOperationItems
            .AsNoTracking()
            .Where(candidate => candidate.OperationId == operationId)
            .OrderBy(candidate => candidate.TemplateSourceId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (mappings.Count > 0)
        {
            var targets = mappings.Select(value => value.TargetItemId).ToArray();
            var provisioning = await _database.Items.IgnoreQueryFilters()
                .CountAsync(candidate => targets.Contains(candidate.Id)
                    && candidate.LifecycleState == ItemLifecycleState.Provisioning, cancellationToken)
                .ConfigureAwait(false);
            if (provisioning != targets.Length)
            {
                return Result.Failure<TemplateOperationWriteAuthorization>(
                    TemplateErrors.NotFound("No such template import stage is visible."));
            }
        }

        return Result.Success(new TemplateOperationWriteAuthorization(
            operationId,
            Context.TenantId,
            Context.PrincipalId,
            operation.WorkspaceId,
            mappings.Select(value => new TemplateBodyWrite(
                value.TemplateSourceId,
                value.TargetItemId,
                value.ItemType,
                value.BodyRequired)).ToArray(),
            CanWrite: true));
    }

    /// <summary>Authorizes a source or staged target body for one in-progress operation.</summary>
    public async ValueTask<Result<TemplateOperationAuthorization>> AuthorizeOperationItemAsync(
        Guid operationId,
        ItemId itemId,
        CancellationToken cancellationToken)
    {
        var operation = await _database.TemplateOperations
            .FirstOrDefaultAsync(candidate => candidate.Id == TemplateOperationId.From(operationId), cancellationToken)
            .ConfigureAwait(false);
        if (operation is not null)
        {
            if (operation.ActorId != Context.PrincipalId
                || operation.State != TemplateOperationState.Provisioning
                || operation.ExpiresAt <= _clock.GetUtcNow()
                || !await _permissions.CanWriteWorkspaceAsync(operation.WorkspaceId, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<TemplateOperationAuthorization>(
                    TemplateErrors.NotFound("No such staging item is visible."));
            }

            var operationTypedId = TemplateOperationId.From(operationId);
            var mapping = await _database.TemplateOperationItems
                .FirstOrDefaultAsync(
                    candidate => candidate.OperationId == operationTypedId
                        && (candidate.SourceItemId == itemId || candidate.TargetItemId == itemId),
                    cancellationToken)
                .ConfigureAwait(false);
            if (mapping is null)
            {
                return Result.Failure<TemplateOperationAuthorization>(
                    TemplateErrors.NotFound("No such staging item is visible."));
            }

            var operationTargetCanWrite = mapping.TargetItemId == itemId
                && mapping.BodyRequired
                && await _database.Items.IgnoreQueryFilters().AnyAsync(
                    candidate => candidate.Id == itemId
                        && candidate.LifecycleState == ItemLifecycleState.Provisioning,
                    cancellationToken).ConfigureAwait(false);

            return Result.Success(new TemplateOperationAuthorization(
                operationId,
                itemId,
                Context.TenantId,
                Context.PrincipalId,
                operation.WorkspaceId,
                mapping.ItemType,
                mapping.SourceItemId == itemId,
                mapping.TargetItemId == itemId,
                operationTargetCanWrite));
        }

        var applicationTypedId = TemplateApplicationId.From(operationId);
        var application = await _database.TemplateApplications
            .FirstOrDefaultAsync(candidate => candidate.Id == applicationTypedId, cancellationToken)
            .ConfigureAwait(false);
        if (application is null
            || application.ActorId != Context.PrincipalId
            || application.State != TemplateOperationState.Provisioning
            || application.ExpiresAt <= _clock.GetUtcNow()
            || !await _permissions.CanWriteWorkspaceAsync(application.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateOperationAuthorization>(
                TemplateErrors.NotFound("No such staging item is visible."));
        }

        var applicationMapping = await _database.TemplateApplicationItems
            .FirstOrDefaultAsync(
                candidate => candidate.ApplicationId == applicationTypedId
                    && (candidate.SourceItemId == itemId || candidate.TargetItemId == itemId),
                cancellationToken)
            .ConfigureAwait(false);
        if (applicationMapping is null)
        {
            return Result.Failure<TemplateOperationAuthorization>(
                TemplateErrors.NotFound("No such staging item is visible."));
        }


        var applicationTargetCanWrite = applicationMapping.TargetItemId == itemId
            && applicationMapping.Created
            && applicationMapping.BodyRequired
            && await _database.Items.IgnoreQueryFilters().AnyAsync(
                candidate => candidate.Id == itemId
                    && candidate.LifecycleState == ItemLifecycleState.Provisioning,
                cancellationToken).ConfigureAwait(false);

        var sourceItem = await _database.Items.IgnoreQueryFilters()
            .SingleAsync(candidate => candidate.Id == applicationMapping.SourceItemId, cancellationToken)
            .ConfigureAwait(false);
        return Result.Success(new TemplateOperationAuthorization(
            operationId,
            itemId,
            Context.TenantId,
            Context.PrincipalId,
            application.WorkspaceId,
            sourceItem.Type,
            applicationMapping.SourceItemId == itemId,
            applicationMapping.TargetItemId == itemId,
            applicationTargetCanWrite));
    }

    /// <summary>Authorizes an active hidden template body for read or user-template editing.</summary>
    public async ValueTask<Result<TemplateItemAuthorization>> AuthorizeTemplateItemAsync(
        TemplateId templateId,
        Guid sourceId,
        CancellationToken cancellationToken)
    {
        var template = await ActiveTemplateAsync(templateId, cancellationToken).ConfigureAwait(false);
        if (template is null
            || !await _permissions.CanReadWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateItemAuthorization>(TemplateErrors.NotFound("No such template item is visible."));
        }

        var activeIds = (await ActiveTreeAsync(template, cancellationToken).ConfigureAwait(false))
            .Where(item => item.TemplateSourceId == sourceId)
            .ToList();
        if (activeIds.Count != 1)
        {
            return Result.Failure<TemplateItemAuthorization>(TemplateErrors.NotFound("No such template item is visible."));
        }

        var item = activeIds[0];
        return Result.Success(new TemplateItemAuthorization(
            templateId,
            sourceId,
            item.Id,
            Context.TenantId,
            Context.PrincipalId,
            template.WorkspaceId,
            item.Type,
            true,
            false));
    }

    /// <summary>Returns a parent-first envelope snapshot for template-profile export.</summary>
    public async ValueTask<Result<TemplateExportSnapshot>> ExportAsync(
        TemplateId templateId,
        CancellationToken cancellationToken)
    {
        var template = await ActiveTemplateAsync(templateId, cancellationToken).ConfigureAwait(false);
        if (template is null
            || !await _permissions.CanReadWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateExportSnapshot>(TemplateErrors.NotFound("No such template is visible."));
        }

        var items = await ActiveTreeAsync(template, cancellationToken).ConfigureAwait(false);
        if (ContainsFileItems(items))
        {
            return Result.Failure<TemplateExportSnapshot>(TemplateErrors.FileAttachmentsUnsupported());
        }
        var byItem = items.ToDictionary(item => item.Id, item => item.TemplateSourceId!.Value);
        var bodies = await BodyItemIdsAsync(items.Select(item => item.Id), cancellationToken).ConfigureAwait(false);
        return Result.Success(new TemplateExportSnapshot(
            template.Id,
            template.WorkspaceId,
            template.ProfileKey,
            template.Title,
            template.Description,
            template.Origin,
            template.Revision,
            template.IncludeBody,
            template.IncludeChildren,
            items.Select(item => new TemplateExportItem(
                item.TemplateSourceId!.Value,
                item.ParentId is { } parent ? byItem[parent] : null,
                item.Id,
                item.Type,
                ItemProperties.ReadTitle(item.Properties),
                item.Seq,
                item.Properties,
                item.Schema,
                item.Views,
                bodies.Contains(item.Id))).ToArray()));
    }

}
