namespace Nix.Api.Tests.Support;

/// <summary>
/// A clock frozen at a known instant, substituted for <see cref="TimeProvider.System"/>
/// so a test can assert the exact timestamp an endpoint reports.
/// </summary>
public sealed class FixedTimeProvider(DateTimeOffset instant) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => instant;
}
