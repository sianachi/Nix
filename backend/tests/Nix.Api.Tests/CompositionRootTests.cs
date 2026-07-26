namespace Nix.Api.Tests;

public sealed class CompositionRootTests
{
    [Fact]
    public void Api_host_exposes_a_public_entry_point_for_test_hosting()
    {
        // The Program marker must stay public so WebApplicationFactory<Program>
        // can host the application in later goals.
        Assert.True(typeof(Program).IsPublic);
    }
}
