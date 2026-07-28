namespace Nix.Features.Health;

/// <summary>
/// Identity and clock of the running service. Used by operators and by the
/// frontend's build-mismatch banner, so the field set is a contract.
/// </summary>
/// <param name="Service">Logical service name, stable across deployments.</param>
/// <param name="Version">Informational assembly version of the running build.</param>
/// <param name="UtcNow">Server clock at the moment of the request, always UTC.</param>
internal sealed record ServiceStatusResponse(string Service, string Version, DateTimeOffset UtcNow);
