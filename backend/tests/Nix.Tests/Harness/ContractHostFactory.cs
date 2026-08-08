using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Nix.Tests.Harness;

/// <summary>
/// The application hosted outside Development, so no developer's user-secrets store decides what
/// these tests are testing.
/// </summary>
/// <remarks>
/// <para>
/// <b>The bug this exists to close.</b> <see cref="WebApplicationFactory{TEntryPoint}"/> boots the
/// real <c>Program</c> in the Development environment, and Development loads user secrets. A
/// developer who has run the application locally has <c>ConnectionStrings:Nix</c> in that store -
/// it is in <c>docs/dev-signing-in.md</c>'s cold-start sequence - and <c>Program</c> reads it,
/// decides persistence is configured, and installs the unit-of-work middleware. Every unauthenticated
/// request then answers 401 before it reaches the route at all.
/// </para>
/// <para>
/// The suite therefore passed in CI, where no such secret exists, and failed on the machine of
/// anybody who had ever started the dev stack. That is the worst shape a test can have: it does not
/// describe the code, it describes the laptop, and the failure it reports is not the one it is
/// named for.
/// </para>
/// <para>
/// Running the host outside Development makes the host under test the host the tests mean. It is
/// deliberately not a way to exercise the persistence-configured pipeline - that needs a real
/// database and a tenant-scoped transaction, and lives in <c>Nix.Integration.Tests</c>.
/// </para>
/// <para>
/// <b>What this does not close.</b> An exported <c>ConnectionStrings__Nix</c> still reaches the
/// host: environment variables are read whatever the environment is named, and no hook a factory
/// offers runs early enough to remove one - <c>Program</c> reads the value while
/// <c>WebApplicationBuilder</c> is being constructed, before any of them. Closing that door means
/// mutating process-wide environment state around host construction, which is worse than the
/// problem while test collections run in parallel. It is left open knowingly: nothing exports that
/// variable to run a unit suite, <c>ci-backend.yml</c>'s unit job sets no environment at all, and
/// the leak that actually bit was the user-secrets store, which is now shut.
/// </para>
/// </remarks>
public sealed class ContractHostFactory : WebApplicationFactory<Program>
{
    /// <summary>The environment these tests run the application as.</summary>
    /// <remarks>
    /// Anything but Development, which is the only environment that loads the user-secrets store.
    /// Named rather than inlined because it is the entire mechanism.
    /// </remarks>
    private const string TestEnvironment = "Testing";

    /// <inheritdoc />
    /// <remarks>
    /// <para>
    /// <b>Why the environment, and not a configuration override.</b> Neither
    /// <c>ConfigureAppConfiguration</c> on the web host builder nor on the host builder can fix
    /// this, and both were tried. <c>Program</c> reads the connection string from
    /// <c>WebApplicationBuilder.Configuration</c> while the builder is being constructed, and
    /// decides then and there whether to install the unit-of-work middleware. Every hook a factory
    /// offers runs after that decision has already been taken, so a value supplied through one is
    /// a value nothing goes back to read.
    /// </para>
    /// <para>
    /// The environment is different: it comes from host configuration, which is settled before the
    /// builder exists. Out of Development, the user-secrets provider is never added, so the key is
    /// not there to be read in the first place.
    /// </para>
    /// </remarks>
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.UseEnvironment(TestEnvironment);
    }
}
