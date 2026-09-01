using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Plugins;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Http;
using Nix.Persistence.ObjectStorage;
using Nix.Persistence.Plugins;

namespace Nix.Features.Plugins;

internal static class PluginEndpoints
{
    internal static IEndpointRouteBuilder MapPluginEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var plugins = endpoints.MapGroup("/api/v1/workspaces/{workspaceId:guid}/plugins")
            .WithTags("Plugins");
        plugins.MapGet("", List)
            .WithName("ListWorkspacePlugins")
            .Produces<IReadOnlyList<PluginInstallationResponse>>()
            .ProducesProblem(404);
        plugins.MapPost("/components/upload", BeginUpload)
            .WithName("BeginPluginComponentUpload")
            .Produces<PluginComponentUploadResponse>()
            .ProducesProblem(400)
            .ProducesProblem(403)
            .ProducesProblem(404)
            .ProducesProblem(503)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        plugins.MapPost("", Register)
            .WithName("RegisterWorkspacePlugin")
            .Produces<PluginInstallationResponse>(StatusCodes.Status201Created)
            .Produces<PluginInstallationResponse>()
            .ProducesProblem(400)
            .ProducesProblem(403)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(503)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        plugins.MapPut("/{installationId:guid}/enabled", SetEnabled)
            .WithName("SetWorkspacePluginEnabled")
            .Produces<PluginInstallationResponse>()
            .ProducesProblem(403)
            .ProducesProblem(404)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        plugins.MapPut("/{installationId:guid}/capabilities", ReplaceCapabilities)
            .WithName("ReplaceWorkspacePluginCapabilities")
            .Produces<PluginInstallationResponse>()
            .ProducesProblem(400)
            .ProducesProblem(403)
            .ProducesProblem(404)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    private static async Task<IResult> List(
        Guid workspaceId,
        HttpContext context,
        [FromServices] IPermissionResolver permissions,
        [FromServices] PluginInstallationStore installations)
    {
        var target = WorkspaceId.From(workspaceId);
        if (workspaceId == Guid.Empty
            || !await permissions.CanReadWorkspaceAsync(target, context.RequestAborted)
                .ConfigureAwait(false))
        {
            return NotFound(context);
        }

        var values = await installations.ListAsync(target, context.RequestAborted).ConfigureAwait(false);
        return TypedResults.Ok<IReadOnlyList<PluginInstallationResponse>>(
            values.Select(ToResponse).ToArray());
    }

    private static async Task<IResult> BeginUpload(
        Guid workspaceId,
        BeginPluginComponentUploadRequest request,
        HttpContext context,
        [FromServices] IPermissionResolver permissions,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer)
    {
        var target = WorkspaceId.From(workspaceId);
        var refusal = await ManagementRefusal(target, workspaceId, context, permissions).ConfigureAwait(false);
        if (refusal is not null)
        {
            return refusal;
        }
        if (!signer.IsConfigured)
        {
            return Problem(
                context,
                503,
                "plugins.storage_unavailable",
                "Plugin storage unavailable",
                "Private object storage is not configured.");
        }

        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        if (!TryRegistration(scoped.TenantId, request, out var registration))
        {
            return InvalidComponent(context);
        }

        var capability = signer.PutImmutableVerified(
            registration.ObjectKey,
            registration.ByteLength,
            registration.Sha256);
        return TypedResults.Ok(new PluginComponentUploadResponse(
            registration.ObjectKey,
            capability.Url,
            capability.ExpiresAt,
            "*",
            Convert.ToBase64String(Convert.FromHexString(registration.Sha256))));
    }

    private static async Task<IResult> Register(
        Guid workspaceId,
        PluginComponentRegistrationRequest request,
        HttpContext context,
        [FromServices] IPermissionResolver permissions,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] PluginInstallationStore installations,
        [FromServices] S3CapabilitySigner signer)
    {
        var target = WorkspaceId.From(workspaceId);
        var refusal = await ManagementRefusal(target, workspaceId, context, permissions).ConfigureAwait(false);
        if (refusal is not null)
        {
            return refusal;
        }
        if (!signer.IsConfigured)
        {
            return Problem(
                context,
                503,
                "plugins.storage_unavailable",
                "Plugin storage unavailable",
                "Private object storage is not configured.");
        }

        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        if (!PluginContractValidator.TryComponent(scoped.TenantId, request, out var registration))
        {
            return InvalidComponent(context);
        }

        var result = await installations.RegisterAsync(
            target,
            registration,
            context.RequestAborted).ConfigureAwait(false);
        return result.Outcome switch
        {
            PluginRegistrationOutcome.Created => TypedResults.Created(
                $"/api/v1/workspaces/{workspaceId:D}/plugins/{result.Installation!.Id}",
                ToResponse(result.Installation)),
            PluginRegistrationOutcome.Existing => TypedResults.Ok(ToResponse(result.Installation!)),
            PluginRegistrationOutcome.PublisherKeyConflict => Conflict(
                context,
                "plugins.publisher_key_conflict",
                "The publisher name is pinned to a different signing key."),
            PluginRegistrationOutcome.ComponentConflict => Conflict(
                context,
                "plugins.component_conflict",
                "This component version is already registered with different immutable metadata."),
            PluginRegistrationOutcome.InstallationConflict => Conflict(
                context,
                "plugins.installation_conflict",
                "This workspace already installs another version of the component."),
            PluginRegistrationOutcome.WorkspaceLimit => Conflict(
                context,
                "plugins.workspace_limit",
                "This workspace has reached its plugin installation limit."),
            _ => throw new InvalidOperationException($"Unknown registration outcome {result.Outcome}."),
        };
    }

    private static async Task<IResult> SetEnabled(
        Guid workspaceId,
        Guid installationId,
        SetPluginEnabledRequest request,
        HttpContext context,
        [FromServices] IPermissionResolver permissions,
        [FromServices] PluginInstallationStore installations)
    {
        var target = WorkspaceId.From(workspaceId);
        var refusal = await ManagementRefusal(target, workspaceId, context, permissions).ConfigureAwait(false);
        if (refusal is not null)
        {
            return refusal;
        }
        if (installationId == Guid.Empty)
        {
            return NotFound(context);
        }

        var changed = await installations.SetEnabledAsync(
            target,
            PluginInstallationId.From(installationId),
            request.Enabled,
            context.RequestAborted).ConfigureAwait(false);
        return changed is null ? NotFound(context) : TypedResults.Ok(ToResponse(changed));
    }

    private static async Task<IResult> ReplaceCapabilities(
        Guid workspaceId,
        Guid installationId,
        ReplacePluginCapabilitiesRequest request,
        HttpContext context,
        [FromServices] IPermissionResolver permissions,
        [FromServices] PluginInstallationStore installations)
    {
        var target = WorkspaceId.From(workspaceId);
        var refusal = await ManagementRefusal(target, workspaceId, context, permissions).ConfigureAwait(false);
        if (refusal is not null)
        {
            return refusal;
        }
        if (installationId == Guid.Empty
            || request.Capabilities is null
            || request.Capabilities.Count > 32)
        {
            return InvalidCapabilities(context);
        }

        var capabilities = new HashSet<string>(request.Capabilities, StringComparer.Ordinal);
        if (capabilities.Count != request.Capabilities.Count
            || capabilities.Any(value => !string.Equals(
                value,
                PluginRuntimePolicy.ReadItemMetadataCapability,
                StringComparison.Ordinal)))
        {
            return InvalidCapabilities(context);
        }

        var changed = await installations.ReplaceGrantsAsync(
            target,
            PluginInstallationId.From(installationId),
            capabilities,
            context.RequestAborted).ConfigureAwait(false);
        return changed is null ? NotFound(context) : TypedResults.Ok(ToResponse(changed));
    }

    private static async ValueTask<IResult?> ManagementRefusal(
        WorkspaceId workspaceId,
        Guid rawWorkspaceId,
        HttpContext context,
        IPermissionResolver permissions)
    {
        if (rawWorkspaceId != Guid.Empty
            && await permissions.CanManageWorkspaceAsync(workspaceId, context.RequestAborted)
                .ConfigureAwait(false))
        {
            return null;
        }

        return rawWorkspaceId == Guid.Empty
            || !await permissions.CanReadWorkspaceAsync(workspaceId, context.RequestAborted)
                .ConfigureAwait(false)
            ? NotFound(context)
            : Problem(
                context,
                403,
                "plugins.management_forbidden",
                "Plugin management refused",
                "Only a workspace owner or tenant administrator can manage plugins.");
    }

    private static bool TryRegistration(
        TenantId tenantId,
        BeginPluginComponentUploadRequest request,
        out PluginComponentRegistration registration)
    {
        registration = default!;
        string objectKey;
        try
        {
            objectKey = ObjectStorageKeys.PluginComponent(
                tenantId,
                request.Id,
                request.Version,
                request.Sha256);
        }
        catch (ArgumentException)
        {
            return false;
        }

        return PluginContractValidator.TryComponent(
            tenantId,
            new PluginComponentRegistrationRequest(
                request.PublisherId,
                request.Id,
                request.Version,
                objectKey,
                request.Sha256,
                request.ByteLength,
                request.PublicKey,
                request.Signature),
            out registration);
    }

    private static PluginInstallationResponse ToResponse(PluginInstallationSnapshot value) => new(
        value.Id.Value,
        value.WorkspaceId.Value,
        value.PublisherId,
        value.ComponentId,
        value.Version,
        value.Sha256,
        value.ByteLength,
        value.Enabled,
        value.Capabilities,
        value.InstalledAt,
        value.UpdatedAt);

    private static ProblemHttpResult InvalidComponent(HttpContext context) => Problem(
        context,
        400,
        "plugins.component_invalid",
        "Plugin component invalid",
        "The publisher, component identity, version, digest, size, key, signature, or object key is invalid.");

    private static ProblemHttpResult InvalidCapabilities(HttpContext context) => Problem(
        context,
        400,
        "plugins.capabilities_invalid",
        "Plugin capabilities invalid",
        "The capability set contains duplicates or a capability this runtime does not implement.");

    private static ProblemHttpResult NotFound(HttpContext context) => Problem(
        context,
        404,
        "plugins.not_found",
        "Plugin not found",
        "No such workspace plugin is visible.");

    private static ProblemHttpResult Conflict(HttpContext context, string code, string detail) => Problem(
        context,
        409,
        code,
        "Plugin registration conflicts",
        detail);

    private static ProblemHttpResult Problem(
        HttpContext context,
        int status,
        string code,
        string title,
        string detail) => TypedResults.Problem(ApiProblem.Create(context, status, code, title, detail));
}
