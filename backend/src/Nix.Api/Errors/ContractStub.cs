using Microsoft.AspNetCore.Http.HttpResults;

namespace Nix.Errors;

/// <summary>
/// The response every endpoint whose contract is published but whose behaviour is not yet built
/// returns.
/// </summary>
/// <remarks>
/// <para>
/// This exists so the two development lanes can be decoupled. The frontend generates its types
/// and its mock handlers from the OpenAPI document, not from live responses, so publishing the
/// request and response shapes is enough to unblock a whole phase of client work - and publishing
/// them early is worth much more than publishing them complete.
/// </para>
/// <para>
/// <b>Why 501 and not sample data.</b> An endpoint that returns a plausible-looking item would be
/// indistinguishable from a working one, and the first person to build against it would discover
/// the difference only after trusting it. A 501 with a stable code cannot be mistaken for
/// anything: the route exists, the contract is real, the behaviour is not here yet. The declared
/// 200 shape still reaches the OpenAPI document through the endpoint's <c>Produces</c> metadata,
/// which is the part the client actually consumes.
/// </para>
/// <para>
/// Each of these disappears in the goal that implements the endpoint. A search for
/// <see cref="NotImplementedCode"/> is the list of what is still owed.
/// </para>
/// </remarks>
internal static class ContractStub
{
    /// <summary>
    /// Stable code for "this endpoint's contract is published but its behaviour is not built".
    /// </summary>
    /// <remarks>
    /// Distinct from <see cref="ApiProblem.UnexpectedCode"/> on purpose: a client seeing this
    /// knows the call was well-formed and the feature is simply absent, which is a different
    /// thing to tell a user than "something went wrong".
    /// </remarks>
    internal const string NotImplementedCode = "api.not_implemented";

    /// <summary>
    /// Builds the not-implemented problem response for <paramref name="operation"/>.
    /// </summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="operation">
    /// The operation's contract name, echoed in the detail so a client that hits one knows exactly
    /// which endpoint is outstanding.
    /// </param>
    /// <returns>A 501 problem-details result.</returns>
    internal static ProblemHttpResult NotImplemented(HttpContext httpContext, string operation) =>
        TypedResults.Problem(ApiProblem.Create(
            httpContext,
            StatusCodes.Status501NotImplemented,
            NotImplementedCode,
            "Not implemented",
            $"The contract for '{operation}' is published and stable, but its behaviour has not "
            + "been built yet. Build against the OpenAPI document and the generated mocks."));
}
