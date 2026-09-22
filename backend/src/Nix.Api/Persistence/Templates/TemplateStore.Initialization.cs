using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Authorization;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Templates;

namespace Nix.Persistence.Templates;

public sealed partial class TemplateStore
{
    private static readonly JsonSerializerOptions ApplicationResolutionJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private sealed record PreparedTemplateApplication(
        TemplateInitializationResult Evaluation,
        TemplateApplicationResolution Resolution,
        IReadOnlyList<TemplateInitializedItem> Preview,
        string? ResolvedCreateTitle,
        string RequestFingerprint,
        HashSet<ItemId> SourceBodyIds);

    private sealed record TemplateApplicationFingerprint(
        int Version,
        Guid TemplateId,
        int TemplateRevision,
        string Mode,
        Guid? TargetItemId,
        Guid? ParentItemId,
        string? RequestedTitle,
        SortedDictionary<string, string> Inputs);

    private sealed record PrincipalDisplay(Guid Id, string DisplayName);

    private async ValueTask<Result<PreparedTemplateApplication>> PrepareApplicationAsync(
        WorkspaceTemplate template,
        List<Item> source,
        TemplateApplicationMode mode,
        ItemId? targetItemId,
        ItemId? parentItemId,
        string? title,
        IReadOnlyDictionary<string, string>? suppliedInputs,
        Dictionary<Guid, ItemId> existingBySource,
        int? expectedRevision,
        CancellationToken cancellationToken)
    {
        if (expectedRevision is { } expected && expected != template.Revision)
        {
            return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Conflict(
                $"Template revision {expected} is stale; the current revision is {template.Revision}."));
        }

        if (source.Count == 0 || source.Any(item => item.TemplateSourceId is null))
        {
            return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(
                "The template tree is missing stable source identifiers."));
        }

        if (!TemplateInitializationJson.TryRead(template.Initialization, out var initialization, out var parseRefusal))
        {
            return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(parseRefusal!));
        }

        var sourceIds = source.Select(item => item.TemplateSourceId!.Value).ToHashSet();
        var newItems = source.Where(item => mode == TemplateApplicationMode.Create
                || !existingBySource.ContainsKey(item.TemplateSourceId!.Value))
            .ToArray();
        var newSourceIds = newItems.Select(item => item.TemplateSourceId!.Value).ToHashSet();
        var sourceRootTitle = ItemProperties.ReadTitle(source.Single(item => item.ParentId is null).Properties);
        var defaultCreateTitle = TemplateInitializationEvaluator.ReadTextBindingKeys(sourceRootTitle).Count > 0
            ? sourceRootTitle
            : template.Title;
        var selectedCreateTitle = mode == TemplateApplicationMode.Create
            ? title?.Trim() ?? defaultCreateTitle
            : null;
        if (TemplateInitializationValidator.Validate(initialization, sourceIds) is { } definitionRefusal)
        {
            return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(definitionRefusal));
        }

        suppliedInputs ??= new Dictionary<string, string>(StringComparer.Ordinal);
        if (suppliedInputs.Count > TemplateInitializationValidator.MaximumInputs)
        {
            return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(
                $"A template application may provide at most {TemplateInitializationValidator.MaximumInputs} input values."));
        }

        var definitions = initialization.Inputs.ToDictionary(input => input.Key, StringComparer.Ordinal);
        foreach (var pair in suppliedInputs)
        {
            if (!definitions.TryGetValue(pair.Key, out var definition))
            {
                return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(
                    $"Initialization input '{pair.Key}' is not declared by this template."));
            }

            if (pair.Value is null)
            {
                return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(
                    $"Initialization input '{pair.Key}' must be a string."));
            }

            if (!(pair.Value is { Length: 0 } && !definition.Required)
                && (TemplateInitializationValidator.ValidateInputValue(definition, pair.Value) is { } valueRefusal))
            {
                return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(
                    $"Initialization input '{pair.Key}' {valueRefusal}"));
            }
        }

        var sourceBodyIds = newItems.Length == 0
            ? new HashSet<ItemId>()
            : await BodyItemIdsAsync(newItems.Select(item => item.Id), cancellationToken).ConfigureAwait(false);
        var hasNewBody = sourceBodyIds.Count > 0;
        var requiredKeysForNewNodes = initialization.Rules
            .Where(rule => newSourceIds.Contains(rule.SourceId) && rule.InputKey is not null)
            .Select(rule => rule.InputKey!)
            .ToHashSet(StringComparer.Ordinal);
        foreach (var item in newItems)
        {
            requiredKeysForNewNodes.UnionWith(TemplateInitializationEvaluator.ReadTextBindingKeys(
                mode == TemplateApplicationMode.Create && item.Id == source[0].Id
                    ? selectedCreateTitle!
                    : ItemProperties.ReadTitle(item.Properties)));
        }

        if (hasNewBody)
        {
            requiredKeysForNewNodes.UnionWith(initialization.Inputs.Select(input => input.Key));
        }

        var applicationInitialization = initialization with
        {
            Inputs = initialization.Inputs.Where(input => requiredKeysForNewNodes.Contains(input.Key)).ToArray(),
            Rules = initialization.Rules.Where(rule => newSourceIds.Contains(rule.SourceId)).ToArray(),
            References = hasNewBody ? initialization.References : [],
        };
        var applicationInputs = suppliedInputs
            .Where(pair => requiredKeysForNewNodes.Contains(pair.Key))
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);

        var principalIds = new HashSet<PrincipalId>();
        var referencedItemIds = new HashSet<ItemId>();
        var candidateValues = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var definition in applicationInitialization.Inputs)
        {
            if (suppliedInputs.TryGetValue(definition.Key, out var explicitValue)
                && explicitValue is { Length: 0 }
                && !definition.Required)
            {
                continue;
            }

            var candidate = suppliedInputs.TryGetValue(definition.Key, out var supplied)
                ? supplied
                : definition.DefaultValue;
            if (candidate is null)
            {
                continue;
            }

            if (TemplateInitializationValidator.ValidateInputValue(definition, candidate) is { } valueRefusal)
            {
                return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(
                    $"Initialization input '{definition.Key}' {valueRefusal}"));
            }

            var canonical = TemplateInitializationValidator.CanonicalInputValue(definition.Type, candidate);
            candidateValues[definition.Key] = canonical;
            if (definition.Type == TemplateInitializationInputType.Member)
            {
                principalIds.Add(PrincipalId.From(Guid.ParseExact(canonical, "D")));
            }
            else if (definition.Type == TemplateInitializationInputType.Item)
            {
                referencedItemIds.Add(ItemId.From(Guid.ParseExact(canonical, "D")));
            }
        }

        referencedItemIds.UnionWith(applicationInitialization.References
            .Where(reference => reference.Policy == TemplateReferencePolicy.Retain)
            .Select(reference => ItemId.From(reference.SourceItemId)));

        var displayValues = new Dictionary<string, string>(StringComparer.Ordinal);
        if (principalIds.Count > 0)
        {
            var principalRows = await _database.Principals
                .AsNoTracking()
                .Where(principal => principal.TenantId == Context.TenantId
                    && principalIds.Contains(principal.Id)
                    && principal.Status == PrincipalStatus.Active)
                .Select(principal => new { principal.Id, principal.DisplayName })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            var principalDisplays = principalRows
                .Select(principal => new PrincipalDisplay(principal.Id.Value, principal.DisplayName))
                .ToArray();
            var activePrincipalIds = principalRows.Select(principal => principal.Id).ToHashSet();
            var principalGuids = principalIds.Select(id => id.Value).ToArray();
            var directMemberIds = await _database.WorkspaceMembers
                .AsNoTracking()
                .Where(member => member.TenantId == Context.TenantId
                    && member.WorkspaceId == template.WorkspaceId
                    && member.SubjectType == SubjectType.Principal
                    && principalGuids.Contains(member.SubjectId))
                .Select(member => member.SubjectId)
                .ToHashSetAsync(cancellationToken)
                .ConfigureAwait(false);
            var groupIds = await _database.WorkspaceMembers
                .AsNoTracking()
                .Where(member => member.TenantId == Context.TenantId
                    && member.WorkspaceId == template.WorkspaceId
                    && member.SubjectType == SubjectType.Group)
                .Select(member => member.SubjectId)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            var typedGroupIds = groupIds.Select(PrincipalGroupId.From).ToHashSet();
            var groupMemberIds = groupIds.Length == 0
                ? new HashSet<Guid>()
                : (await _database.GroupMemberships
                    .AsNoTracking()
                    .Where(membership => membership.TenantId == Context.TenantId
                        && typedGroupIds.Contains(membership.GroupId)
                        && activePrincipalIds.Contains(membership.PrincipalId))
                    .Select(membership => membership.PrincipalId)
                    .ToArrayAsync(cancellationToken)
                    .ConfigureAwait(false))
                    .Select(principalId => principalId.Value)
                    .ToHashSet();
            directMemberIds.UnionWith(groupMemberIds);
            var availableMembers = principalDisplays
                .Where(principal => directMemberIds.Contains(principal.Id))
                .ToDictionary(principal => principal.Id, principal => principal.DisplayName);
            foreach (var input in applicationInitialization.Inputs.Where(input => input.Type == TemplateInitializationInputType.Member))
            {
                if (!candidateValues.TryGetValue(input.Key, out var memberText))
                {
                    continue;
                }

                var memberId = Guid.ParseExact(memberText, "D");
                if (!availableMembers.TryGetValue(memberId, out var displayName)
                    || string.IsNullOrWhiteSpace(displayName))
                {
                    return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(
                        $"Initialization input '{input.Key}' must identify an active member of this workspace."));
                }

                displayValues[input.Key] = displayName;
            }
        }

        var accessibleItems = new Dictionary<Guid, Item>();
        if (referencedItemIds.Count > 0)
        {
            var itemRows = await _database.Items
                .AsNoTracking()
                .Where(item => item.TenantId == Context.TenantId
                    && item.WorkspaceId == template.WorkspaceId
                    && item.TemplateId == null
                    && item.LifecycleState == ItemLifecycleState.Active
                    && referencedItemIds.Contains(item.Id))
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            accessibleItems = itemRows.ToDictionary(item => item.Id.Value);
            foreach (var input in applicationInitialization.Inputs.Where(input => input.Type == TemplateInitializationInputType.Item))
            {
                if (!candidateValues.TryGetValue(input.Key, out var itemText))
                {
                    continue;
                }

                var itemId = Guid.ParseExact(itemText, "D");
                if (!accessibleItems.TryGetValue(itemId, out var item))
                {
                    return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(
                        $"Initialization input '{input.Key}' must identify an active item readable in this workspace."));
                }

                var displayName = ItemProperties.ReadTitle(item.Properties);
                if (string.IsNullOrWhiteSpace(displayName))
                {
                    return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(
                        $"Initialization input '{input.Key}' must identify an item with a readable title."));
                }

                displayValues[input.Key] = displayName;
            }

            foreach (var reference in applicationInitialization.References.Where(reference => reference.Policy == TemplateReferencePolicy.Retain))
            {
                if (!accessibleItems.ContainsKey(reference.SourceItemId))
                {
                    return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(
                        "A retained body reference is no longer readable in this workspace; choose a replacement or omit it."));
                }
            }
        }

        if (!TemplateInitializationValidator.TryResolveInputs(
                applicationInitialization,
                applicationInputs,
                displayValues,
                out var resolvedInputs,
                out var inputsRefusal))
        {
            return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(inputsRefusal!));
        }

        var referenceMappings = new Dictionary<Guid, Guid?>();
        foreach (var reference in applicationInitialization.References)
        {
            switch (reference.Policy)
            {
                case TemplateReferencePolicy.Omit:
                    referenceMappings[reference.SourceItemId] = null;
                    break;
                case TemplateReferencePolicy.Retain:
                    referenceMappings[reference.SourceItemId] = reference.SourceItemId;
                    break;
                case TemplateReferencePolicy.Replace:
                    if (!resolvedInputs.Values.TryGetValue(reference.InputKey!, out var replacement))
                    {
                        referenceMappings[reference.SourceItemId] = null;
                        break;
                    }

                    var replacementId = Guid.ParseExact(replacement, "D");
                    if (!accessibleItems.ContainsKey(replacementId))
                    {
                        return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(
                            "A replacement reference must identify an active item readable in this workspace."));
                    }

                    referenceMappings[reference.SourceItemId] = replacementId;
                    break;
            }
        }

        var effectiveSchemas = await ResolveDestinationSchemasAsync(
            source,
            mode,
            parentItemId,
            targetItemId,
            existingBySource,
            cancellationToken).ConfigureAwait(false);
        var initializationItems = newItems.Select(item => new TemplateInitializationItem(
            item.TemplateSourceId!.Value,
            mode == TemplateApplicationMode.Create && item.Id == source[0].Id
                ? selectedCreateTitle!
                : ItemProperties.ReadTitle(item.Properties),
            item.Properties,
            item.Recurrence)).ToArray();
        var newSchemas = initializationItems.ToDictionary(
            item => item.SourceId,
            item => effectiveSchemas[item.SourceId]);
        if (!TemplateInitializationEvaluator.TryEvaluate(
                applicationInitialization,
                initializationItems,
                resolvedInputs,
                newSchemas,
                out var evaluation,
                out var evaluationRefusal,
                sourceIds))
        {
            return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(evaluationRefusal!));
        }

        var assigneeIds = new HashSet<Guid>();
        foreach (var initialized in evaluation.Items)
        {
            if (_validator.ValidateEnvelope(initialized.Properties, null, null) is { } envelopeRefusal)
            {
                return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(envelopeRefusal));
            }

            if (!TryReadAssignee(initialized.Properties, out var assigneeId, out var hasAssignee))
            {
                return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(
                    $"Initialized assignee on template item '{initialized.SourceId}' must be a canonical lowercase UUID."));
            }

            if (hasAssignee)
            {
                assigneeIds.Add(assigneeId);
            }
        }

        if (assigneeIds.Count > 0)
        {
            var typedAssigneeIds = assigneeIds.Select(PrincipalId.From).ToHashSet();
            var activeAssignees = await _database.Principals
                .AsNoTracking()
                .Where(principal => principal.TenantId == Context.TenantId
                    && typedAssigneeIds.Contains(principal.Id)
                    && principal.Status == PrincipalStatus.Active)
                .Select(principal => principal.Id)
                .ToHashSetAsync(cancellationToken)
                .ConfigureAwait(false);
            var workspaceMemberIds = await _database.WorkspaceMembers
                .AsNoTracking()
                .Where(member => member.TenantId == Context.TenantId
                    && member.WorkspaceId == template.WorkspaceId
                    && member.SubjectType == SubjectType.Principal
                    && assigneeIds.Contains(member.SubjectId))
                .Select(member => member.SubjectId)
                .ToHashSetAsync(cancellationToken)
                .ConfigureAwait(false);
            var workspaceGroupIds = await _database.WorkspaceMembers
                .AsNoTracking()
                .Where(member => member.TenantId == Context.TenantId
                    && member.WorkspaceId == template.WorkspaceId
                    && member.SubjectType == SubjectType.Group)
                .Select(member => member.SubjectId)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            var typedWorkspaceGroupIds = workspaceGroupIds.Select(PrincipalGroupId.From).ToHashSet();
            if (workspaceGroupIds.Length > 0)
            {
                var groupAssignees = await _database.GroupMemberships
                    .AsNoTracking()
                    .Where(membership => membership.TenantId == Context.TenantId
                        && typedWorkspaceGroupIds.Contains(membership.GroupId)
                        && typedAssigneeIds.Contains(membership.PrincipalId)
                        && activeAssignees.Contains(membership.PrincipalId))
                    .Select(membership => membership.PrincipalId.Value)
                    .ToHashSetAsync(cancellationToken)
                    .ConfigureAwait(false);
                workspaceMemberIds.UnionWith(groupAssignees);
            }

            if (assigneeIds.Any(id => !activeAssignees.Contains(PrincipalId.From(id)) || !workspaceMemberIds.Contains(id)))
            {
                return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(
                    "An initialized assignee must be an active member of this workspace."));
            }
        }

        string? resolvedCreateTitle = null;
        var preview = evaluation.Items;
        if (mode == TemplateApplicationMode.Create)
        {
            var sourceTitle = selectedCreateTitle!;
            if (!TemplateInitializationEvaluator.TryBindText(sourceTitle, resolvedInputs.TextBindings, out resolvedCreateTitle, out var titleRefusal)
                || string.IsNullOrWhiteSpace(resolvedCreateTitle)
                || resolvedCreateTitle.Length > 200)
            {
                return Result.Failure<PreparedTemplateApplication>(TemplateErrors.Invalid(titleRefusal
                    ?? "The application title must contain between 1 and 200 characters after binding."));
            }

            var rootSourceId = source[0].TemplateSourceId!.Value;
            preview = preview.Select(item => item.SourceId == rootSourceId
                ? item with { Title = resolvedCreateTitle }
                : item).ToArray();
        }

        var resolution = new TemplateApplicationResolution(
            template.Revision,
            resolvedInputs.Values,
            resolvedInputs.TextBindings,
            referenceMappings,
            initialization.Inputs.ToDictionary(input => input.Key, input => input.Type, StringComparer.Ordinal),
            requiredKeysForNewNodes.Order(StringComparer.Ordinal).ToArray());
        var fingerprint = RequestFingerprint(
            template.Id,
            template.Revision,
            mode,
            targetItemId,
            parentItemId,
            title?.Trim(),
            resolvedInputs.Values);
        return Result.Success(new PreparedTemplateApplication(
            evaluation with { Items = preview },
            resolution,
            preview,
            resolvedCreateTitle,
            fingerprint,
            sourceBodyIds));
    }

    private async ValueTask<Dictionary<Guid, PropertySchema>> ResolveDestinationSchemasAsync(
        List<Item> source,
        TemplateApplicationMode mode,
        ItemId? parentItemId,
        ItemId? targetItemId,
        Dictionary<Guid, ItemId> existingBySource,
        CancellationToken cancellationToken)
    {
        var effectiveBySource = new Dictionary<Guid, PropertySchema>(source.Count);
        var existingParentSchemas = new Dictionary<ItemId, PropertySchema>();
        var root = source[0];
        var rootSourceId = root.TemplateSourceId!.Value;
        if (mode == TemplateApplicationMode.Create)
        {
            var parentSchema = await _schemas.ResolveForChildrenAsync(parentItemId, cancellationToken).ConfigureAwait(false);
            var declared = PropertySchemaJson.Read(root.Schema);
            effectiveBySource[rootSourceId] = declared.Inherit
                ? PropertySchema.Merge(parentSchema, declared)
                : declared;
        }
        else
        {
            if (targetItemId is not { } existingRootId)
            {
                return effectiveBySource;
            }

            var targetSchema = await _schemas.ResolveForItemAsync(existingRootId, cancellationToken).ConfigureAwait(false);
            var rootDeclaration = PropertySchemaJson.Read(root.Schema);
            var effectiveRoot = PropertySchema.Merge(
                targetSchema,
                rootDeclaration with { Inherit = targetSchema.Inherit });
            effectiveBySource[rootSourceId] = effectiveRoot;
            existingParentSchemas[existingRootId] = effectiveRoot;
        }

        var byItemId = source.ToDictionary(item => item.Id);
        foreach (var item in source.Skip(1))
        {
            var sourceId = item.TemplateSourceId!.Value;
            var parent = byItemId[item.ParentId!.Value];
            PropertySchema parentSchema;
            if (existingBySource.TryGetValue(parent.TemplateSourceId!.Value, out var existingParentId))
            {
                if (existingParentSchemas.TryGetValue(existingParentId, out var cachedSchema))
                {
                    parentSchema = cachedSchema;
                }
                else
                {
                    parentSchema = await _schemas.ResolveForItemAsync(existingParentId, cancellationToken)
                        .ConfigureAwait(false);
                    existingParentSchemas[existingParentId] = parentSchema;
                }
            }
            else
            {
                parentSchema = effectiveBySource[parent.TemplateSourceId!.Value];
            }

            var declared = PropertySchemaJson.Read(item.Schema);
            effectiveBySource[sourceId] = declared.Inherit
                ? PropertySchema.Merge(parentSchema, declared)
                : declared;
        }

        return effectiveBySource;
    }

    private static string RequestFingerprint(
        TemplateId templateId,
        int revision,
        TemplateApplicationMode mode,
        ItemId? targetItemId,
        ItemId? parentItemId,
        string? requestedTitle,
        IReadOnlyDictionary<string, string> resolvedInputs)
    {
        var payload = new TemplateApplicationFingerprint(
            1,
            templateId.Value,
            revision,
            mode == TemplateApplicationMode.Create ? "create" : "merge",
            targetItemId?.Value,
            parentItemId?.Value,
            requestedTitle,
            new SortedDictionary<string, string>(resolvedInputs.ToDictionary(
                pair => pair.Key,
                pair => pair.Value,
                StringComparer.Ordinal), StringComparer.Ordinal));
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload, ApplicationResolutionJson));
        return Convert.ToHexString(SHA256.HashData(bytes)).ToUpperInvariant();
    }

    private static string WriteStoredResolution(
        TemplateApplicationResolution resolution,
        IReadOnlyList<TemplateInitializedItem> preview) =>
        JsonSerializer.Serialize(new TemplateStoredApplicationResolution(resolution, preview), ApplicationResolutionJson);

    private static bool TryReadStoredResolution(
        string? json,
        out TemplateStoredApplicationResolution? stored)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            stored = null;
            return false;
        }

        try
        {
            stored = JsonSerializer.Deserialize<TemplateStoredApplicationResolution>(json, ApplicationResolutionJson);
            return stored?.Resolution is not null && stored.Resolution.Values is not null
                && stored.Resolution.TextBindings is not null && stored.Resolution.ReferenceMappings is not null
                && stored.Resolution.InputTypes is not null && stored.Resolution.UsedInputKeys is not null
                && stored.InitializationPreview is not null;
        }
        catch (JsonException)
        {
            stored = null;
            return false;
        }
    }

    private static bool ReplayInputsMatch(
        TemplateApplicationResolution resolution,
        IReadOnlyDictionary<string, string>? suppliedInputs)
    {
        if (suppliedInputs is null || suppliedInputs.Count == 0)
        {
            return true;
        }

        var candidate = resolution.Values.ToDictionary(
            pair => pair.Key,
            pair => pair.Value,
            StringComparer.Ordinal);
        foreach (var pair in suppliedInputs)
        {
            if (pair.Value is null || !resolution.InputTypes.TryGetValue(pair.Key, out var type))
            {
                return false;
            }

            if (pair.Value.Length == 0
                && resolution.UsedInputKeys.Contains(pair.Key)
                && !resolution.Values.ContainsKey(pair.Key)
                && resolution.TextBindings.TryGetValue(pair.Key, out var emptyBinding)
                && emptyBinding.Length == 0)
            {
                continue;
            }

            if (!resolution.UsedInputKeys.Contains(pair.Key))
            {
                continue;
            }

            var definition = new TemplateInitializationInput(pair.Key, pair.Key, type, false);
            if (TemplateInitializationValidator.ValidateInputValue(definition, pair.Value) is not null)
            {
                return false;
            }

            candidate[pair.Key] = TemplateInitializationValidator.CanonicalInputValue(type, pair.Value);
        }

        return candidate.Count == resolution.Values.Count
            && candidate.All(pair => resolution.Values.TryGetValue(pair.Key, out var value)
                && string.Equals(value, pair.Value, StringComparison.Ordinal));
    }

    private static bool TryReadAssignee(string? properties, out Guid assigneeId, out bool hasAssignee)
    {
        assigneeId = Guid.Empty;
        hasAssignee = false;
        if (string.IsNullOrWhiteSpace(properties))
        {
            return true;
        }

        try
        {
            if (JsonNode.Parse(properties) is not JsonObject bag
                || !bag.TryGetPropertyValue("assignee", out var assigneeNode)
                || assigneeNode is null)
            {
                return true;
            }

            if (assigneeNode is not JsonValue value
                || !value.TryGetValue(out string? text)
                || text is null
                || !Guid.TryParseExact(text, "D", out assigneeId)
                || !string.Equals(text, assigneeId.ToString("D"), StringComparison.Ordinal))
            {
                return false;
            }

            hasAssignee = true;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static TemplateInitialization ReadInitializationOrThrow(string? json)
    {
        if (!TemplateInitializationJson.TryRead(json, out var initialization, out var refusal))
        {
            throw new InvalidOperationException($"The stored template initialization definition is invalid: {refusal}");
        }

        return initialization;
    }
}
