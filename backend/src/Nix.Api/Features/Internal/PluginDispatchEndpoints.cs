using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Plugins;
using Nix.Domain.Tenancy;
using Nix.Features.Plugins;
using Nix.Persistence.ObjectStorage;
using Nix.Persistence.Plugins;

namespace Nix.Features.Internal;

/// <summary>Service-authenticated, invocation-bound operations for the sandboxed plugin role.</summary>
internal static class PluginDispatchEndpoints
{
    internal static void Map(IEndpointRouteBuilder group)
    {
        group.MapPost("/worker-dispatch/plugins/events/{eventId:guid}/prepare", Prepare);
        group.MapPost("/worker-dispatch/plugins/invocations/{invocationId:guid}/host-calls", HostCall);
        group.MapPost("/worker-dispatch/plugins/invocations/{invocationId:guid}/complete", Complete);
    }

    private static async Task<Results<Ok<PluginPreparationResponse>, BadRequest, NotFound, Conflict>> Prepare(
        Guid eventId,
        PluginEventPreparationRequest request,
        [FromServices] PluginDispatchStore store,
        [FromServices] S3CapabilitySigner signer,
        CancellationToken cancellationToken)
    {
        var causationId = request.CausationId ?? eventId;
        if (!PluginContractValidator.ValidEvent(
                eventId,
                request.TenantId,
                request.WorkspaceId,
                request.ItemId,
                request.Kind,
                request.AggregateVersion,
                causationId,
                request.CausationDepth,
                request.LeaseSeconds))
        {
            return TypedResults.BadRequest();
        }

        var prepared = await store.PrepareAsync(
            new PluginEventEnvelope(
                eventId,
                request.TenantId,
                request.WorkspaceId,
                request.ItemId,
                request.Kind,
                request.AggregateVersion,
                causationId,
                request.CausationDepth),
            request.LeaseSeconds,
            cancellationToken).ConfigureAwait(false);
        if (prepared.Outcome == PluginPreparationOutcome.Invalid)
        {
            return TypedResults.BadRequest();
        }
        if (prepared.Outcome == PluginPreparationOutcome.NotFound)
        {
            return TypedResults.NotFound();
        }
        if (prepared.Outcome == PluginPreparationOutcome.Conflict)
        {
            return TypedResults.Conflict();
        }

        var plans = new List<PluginInvocationPlanResponse>(prepared.Plans.Count);
        foreach (var plan in prepared.Plans)
        {
            if (!ObjectStorageKeys.BelongsTo(TenantId.From(plan.Event.TenantId), plan.ObjectKey))
            {
                throw new InvalidOperationException("A plugin component escaped its tenant object prefix.");
            }

            var download = signer.Get(plan.ObjectKey);
            plans.Add(new PluginInvocationPlanResponse(
                plan.InvocationId.Value,
                plan.InstallationId.Value,
                plan.Attempt,
                plan.LeaseUntil,
                new PluginComponentPlanResponse(
                    plan.PublisherId,
                    plan.ComponentId,
                    plan.Version,
                    plan.Sha256,
                    Convert.ToBase64String(plan.PublicKey.Span),
                    Convert.ToBase64String(plan.Signature.Span),
                    download.Url,
                    download.ExpiresAt,
                    plan.ByteLength),
                plan.Capabilities));
        }

        return TypedResults.Ok(new PluginPreparationResponse(
            Outcome(prepared.Outcome),
            plans));
    }

    private static async Task<Results<Ok<PluginHostCallResponse>, BadRequest, NotFound>> HostCall(
        Guid invocationId,
        PluginHostCallRequest request,
        [FromServices] PluginDispatchStore store,
        CancellationToken cancellationToken)
    {
        if (invocationId == Guid.Empty
            || !PluginContractValidator.TryReadItemMetadata(
                request.Capability,
                request.Request,
                out var itemId))
        {
            return TypedResults.BadRequest();
        }

        var metadata = await store.ReadItemMetadataAsync(
            PluginInvocationId.From(invocationId),
            itemId,
            cancellationToken).ConfigureAwait(false);
        return metadata is null
            ? TypedResults.NotFound()
            : TypedResults.Ok(new PluginHostCallResponse(new PluginItemMetadataResponse(
                metadata.ItemId,
                metadata.WorkspaceId,
                metadata.ParentId,
                metadata.ItemType,
                metadata.Title,
                metadata.LifecycleState,
                metadata.LastModifiedAt,
                metadata.CausationId,
                metadata.CausationDepth)));
    }

    private static async Task<Results<Ok<PluginCompletionResponse>, BadRequest, NotFound, Conflict>> Complete(
        Guid invocationId,
        PluginCompletionRequest request,
        [FromServices] PluginDispatchStore store,
        CancellationToken cancellationToken)
    {
        if (invocationId == Guid.Empty
            || !PluginContractValidator.ValidCompletion(
                request.Succeeded,
                request.Retryable,
                request.ErrorCode,
                request.ErrorDetail))
        {
            return TypedResults.BadRequest();
        }

        var completion = await store.CompleteAsync(
            PluginInvocationId.From(invocationId),
            request.Succeeded,
            request.Retryable,
            request.ErrorCode,
            request.ErrorDetail,
            cancellationToken).ConfigureAwait(false);
        return completion.Outcome switch
        {
            PluginCompletionOutcome.Invalid => TypedResults.BadRequest(),
            PluginCompletionOutcome.NotFound => TypedResults.NotFound(),
            PluginCompletionOutcome.Conflict => TypedResults.Conflict(),
            _ => TypedResults.Ok(new PluginCompletionResponse(
                completion.Outcome == PluginCompletionOutcome.Applied ? "applied" : "replayed",
                completion.ShouldRequeue)),
        };
    }

    private static string Outcome(PluginPreparationOutcome outcome) => outcome switch
    {
        PluginPreparationOutcome.Prepared => "prepared",
        PluginPreparationOutcome.Settled => "settled",
        PluginPreparationOutcome.Busy => "busy",
        _ => throw new InvalidOperationException($"Preparation outcome {outcome} cannot be returned as success."),
    };
}

public sealed record PluginEventPreparationRequest(
    Guid TenantId,
    Guid WorkspaceId,
    Guid? ItemId,
    string Kind,
    long? AggregateVersion,
    Guid? CausationId = null,
    int CausationDepth = 0,
    int LeaseSeconds = 60);

public sealed record PluginPreparationResponse(
    string Outcome,
    IReadOnlyList<PluginInvocationPlanResponse> Plans);

public sealed record PluginInvocationPlanResponse(
    Guid InvocationId,
    Guid InstallationId,
    int Attempt,
    DateTimeOffset LeaseUntil,
    PluginComponentPlanResponse Component,
    IReadOnlyList<string> Capabilities);

public sealed record PluginComponentPlanResponse(
    string PublisherId,
    string Id,
    string Version,
    string Sha256,
    string PublicKey,
    string Signature,
    Uri DownloadUrl,
    DateTimeOffset DownloadExpiresAt,
    long ByteLength);

public sealed record PluginHostCallRequest(string Capability, JsonElement Request);

public sealed record PluginHostCallResponse(PluginItemMetadataResponse Result);

public sealed record PluginItemMetadataResponse(
    Guid ItemId,
    Guid WorkspaceId,
    Guid? ParentId,
    string ItemType,
    string? Title,
    string LifecycleState,
    DateTimeOffset LastModifiedAt,
    Guid CausationId,
    int CausationDepth);

public sealed record PluginCompletionRequest(
    bool Succeeded,
    bool Retryable,
    string? ErrorCode = null,
    string? ErrorDetail = null);

public sealed record PluginCompletionResponse(string Outcome, bool ShouldRequeue);
