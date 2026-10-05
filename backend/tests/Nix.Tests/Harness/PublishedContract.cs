namespace Nix.Tests.Harness;

/// <summary>
/// Locates the committed OpenAPI contract, <c>backend/openapi/nix-api.json</c>.
/// </summary>
/// <remarks>
/// Found by walking up from the test assembly to the repository root rather than by a relative path
/// counted in <c>..</c> segments, because that count changes with the target framework and the
/// build configuration and nothing fails until it does.
/// </remarks>
public static class PublishedContract
{
    /// <summary>The file that marks the repository root; see <c>scripts/check-root-is-unambiguous.sh</c>.</summary>
    private const string RootMarker = "Nix.slnx";

    /// <summary>The contract's path, relative to the repository root.</summary>
    private const string ContractPath = "backend/openapi/nix-api.json";

    /// <summary>The absolute path to the committed contract.</summary>
    /// <returns>The path.</returns>
    /// <exception cref="InvalidOperationException">
    /// The repository root could not be found above the test assembly, or the contract is missing
    /// from it. Both mean the file this test reads is not where it is expected to be, which is a
    /// failure worth naming rather than an assertion against an empty string.
    /// </exception>
    public static string Path()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);

        while (directory is not null)
        {
            if (File.Exists(System.IO.Path.Combine(directory.FullName, RootMarker)))
            {
                var contract = System.IO.Path.Combine(directory.FullName, ContractPath);
                return File.Exists(contract)
                    ? contract
                    : throw new InvalidOperationException(
                        $"Found the repository root at {directory.FullName} but no contract at {contract}. "
                        + "The backend build writes it; run it before this suite.");
            }

            directory = directory.Parent;
        }

        throw new InvalidOperationException(
            $"No {RootMarker} above {AppContext.BaseDirectory}, so the repository root could not be found.");
    }
}
