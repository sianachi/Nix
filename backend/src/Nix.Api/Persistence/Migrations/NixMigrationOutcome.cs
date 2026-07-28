namespace Nix.Persistence.Migrations;

/// <summary>
/// What a migration run did.
/// </summary>
/// <param name="Role">The database role the migrations ran as.</param>
/// <param name="AppliedNow">Migrations this run applied, in order.</param>
/// <param name="AlreadyPresent">Migrations the database already had.</param>
public sealed record NixMigrationOutcome(
    string Role,
    IReadOnlyList<string> AppliedNow,
    IReadOnlyList<string> AlreadyPresent);
