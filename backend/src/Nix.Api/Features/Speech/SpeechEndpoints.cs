using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Errors;
using Nix.Http;

namespace Nix.Features.Speech;

/// <summary>
/// The capability path for interactive speech (ADR-0059): Core issues, the speech worker redeems.
/// </summary>
internal static class SpeechEndpoints
{
    internal static IEndpointRouteBuilder MapSpeechEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var speech = endpoints.MapGroup("/api/v1/speech").WithTags("Speech");
        speech.MapPost("/capabilities", CreateCapability)
            .WithName("CreateSpeechCapability")
            .Produces<SpeechCapabilityResponse>()
            .ProducesProblem(400)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    /// <summary>
    /// Maps the redeem route on the secret-only dispatch boundary.
    /// </summary>
    /// <remarks>
    /// Under <c>/internal/worker-dispatch</c> because that is the one internal family with no
    /// session behind it, and a redeem has none to offer: there is no forwarded user token (the
    /// browser sent the worker a capability, not its bearer) and no job (nothing was queued). The
    /// internal secret proves the caller is a Nix service; the token proves the rest. Like the
    /// other dispatch routes it opens no transaction and touches no table.
    /// </remarks>
    internal static void MapWorkerDispatch(IEndpointRouteBuilder group) =>
        group.MapPost("/worker-dispatch/speech/capabilities/redeem", RedeemCapability);

    private static Results<Ok<SpeechCapabilityResponse>, ProblemHttpResult> CreateCapability(
        CreateSpeechCapabilityRequest request,
        HttpContext context,
        [FromServices] SpeechCapabilityProtector protector,
        [FromServices] INixSessionContextAccessor session)
    {
        if (!SpeechCapabilityProtector.ValidPurpose(request.Purpose))
        {
            return TypedResults.Problem(ApiProblem.Create(
                context,
                StatusCodes.Status400BadRequest,
                "speech.invalid",
                "Speech capability request invalid",
                "The purpose must be 'synthesize' or 'dictate'."));
        }

        // Any authenticated principal: the capability grants use of the speech worker, not
        // access to anything stored, so there is no item or workspace to check it against.
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var capability = protector.Issue(scoped.TenantId.Value, scoped.PrincipalId.Value, request.Purpose!);
        return TypedResults.Ok(new SpeechCapabilityResponse(capability.Token, capability.ExpiresAt));
    }

    private static Results<Ok<RedeemSpeechCapabilityResponse>, ProblemHttpResult> RedeemCapability(
        RedeemSpeechCapabilityRequest request,
        HttpContext context,
        [FromServices] SpeechCapabilityProtector protector)
    {
        var grant = protector.Redeem(request.Token, request.Purpose);
        if (grant is null)
        {
            // One refusal for every cause. The worker cannot act on the difference, and a browser
            // that could provoke the worker into relaying it would be handed a token oracle.
            return TypedResults.Problem(ApiProblem.Create(
                context,
                StatusCodes.Status403Forbidden,
                "speech.capability_refused",
                "Speech capability refused",
                "The capability is not valid for this purpose."));
        }

        return TypedResults.Ok(new RedeemSpeechCapabilityResponse(
            grant.TenantId,
            grant.PrincipalId,
            grant.ExpiresAt));
    }
}
