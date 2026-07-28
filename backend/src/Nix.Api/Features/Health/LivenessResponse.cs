namespace Nix.Features.Health;

/// <summary>
/// Body of the liveness probe. Deliberately the smallest useful payload: the
/// probe answers "is this process able to serve HTTP", nothing more, so it must
/// not touch a dependency and must not grow fields that could make it fail.
/// </summary>
/// <param name="Status">Constant literal <c>healthy</c> when the process serves requests.</param>
internal sealed record LivenessResponse(string Status);
