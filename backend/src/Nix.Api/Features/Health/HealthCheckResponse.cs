namespace Nix.Features.Health;

/// <summary>
/// Result of one named health check. Named checks exist so an operator can probe
/// a single dependency without the aggregate hiding which one is degraded.
/// </summary>
/// <param name="Name">Identifier of the check, matching the route segment.</param>
/// <param name="Status">Constant literal <c>healthy</c> or <c>degraded</c>.</param>
internal sealed record HealthCheckResponse(string Name, string Status);
