using Nix.Infrastructure.Persistence.Migrations;
using Npgsql;
using Respawn;
using Testcontainers.PostgreSql;

namespace Nix.Integration.Tests.Harness;

/// <summary>
/// A disposable Postgres matching the development stack: <c>pgvector/pgvector:pg16</c>, the two
/// roles of the security model, the schema applied by the migrator, and Respawn resetting data
/// between tests.
/// </summary>
/// <remarks>
/// <para>
/// One container for the whole suite - starting Postgres per test class would multiply a
/// two-second cost by every class for no isolation gain, because Respawn already gives each test
/// its own data. Tests therefore have no ordering dependencies and may run in any order, but must
/// not run concurrently against the same tables, which is why the collection is not parallelised.
/// </para>
/// <para>
/// The build order matters and mirrors deployment: superuser creates the roles and the database,
/// the migrator applies the schema, and only then does anything connect as <c>nix_app</c>. No test
/// path connects as the superuser.
/// </para>
/// </remarks>
public sealed class NixPostgresFixture : IAsyncLifetime
{
    private const string SuperuserName = "postgres";
    private const string SuperuserPassword = "nix-test-superuser";

    private readonly PostgreSqlContainer _container = new PostgreSqlBuilder("pgvector/pgvector:pg16")
        .WithUsername(SuperuserName)
        .WithPassword(SuperuserPassword)
        .WithDatabase(SuperuserName)

        // Log every statement the server receives. One test reads this back to assert that the
        // session context arrived as SET LOCAL - the server's own record of what it was told,
        // rather than the application's belief about what it sent.
        .WithCommand("-c", "log_statement=all")
        .Build();

    private Respawner? _respawner;
    private NpgsqlConnection? _respawnConnection;
    private NixPersistenceHost? _application;

    /// <summary>Gets the connection string for the runtime role, <c>nix_app</c>.</summary>
    public string ApplicationConnectionString { get; private set; } = string.Empty;

    /// <summary>Gets the connection string for the schema-owning role, <c>nix_migrator</c>.</summary>
    public string MigratorConnectionString { get; private set; } = string.Empty;

    /// <summary>
    /// Gets the shared application composition root, built through <c>AddNixPersistence</c>.
    /// </summary>
    internal NixPersistenceHost Application =>
        _application ?? throw new InvalidOperationException("The fixture has not been initialised.");

    /// <summary>
    /// Builds a connection string for the runtime role with pool settings of the caller's
    /// choosing.
    /// </summary>
    /// <param name="configure">Applied to the parsed connection string.</param>
    /// <returns>The tuned connection string.</returns>
    public string ApplicationConnectionString_With(Action<NpgsqlConnectionStringBuilder> configure)
    {
        ArgumentNullException.ThrowIfNull(configure);

        var builder = new NpgsqlConnectionStringBuilder(ApplicationConnectionString);
        configure(builder);
        return builder.ConnectionString;
    }

    /// <inheritdoc />
    public async ValueTask InitializeAsync()
    {
        await _container.StartAsync();

        var host = _container.Hostname;
        var port = _container.GetMappedPublicPort(5432);

        var superuserConnectionString = ConnectionStringFor(host, port, SuperuserName, SuperuserPassword, SuperuserName);
        MigratorConnectionString = ConnectionStringFor(
            host, port, NixDatabaseRoles.Migrator, NixDatabaseRoles.Password, NixDatabaseRoles.Database);
        ApplicationConnectionString = ConnectionStringFor(
            host, port, NixDatabaseRoles.Application, NixDatabaseRoles.Password, NixDatabaseRoles.Database);

        await ProvisionClusterAsync(superuserConnectionString, host, port);

        // Migrations run as the migrator, through the same runner the Kubernetes Job invokes.
        // Today it applies nothing (there are no migrations yet) but it does assert the role
        // privileges, so the harness proves the deployment path rather than simulating it.
        await NixMigrationRunner.RunAsync(MigratorConnectionString, NixDatabaseRoles.Application);

        await ApplyProbeSchemaAsync();

        _respawnConnection = new NpgsqlConnection(MigratorConnectionString);
        await _respawnConnection.OpenAsync();
        _respawner = await Respawner.CreateAsync(
            _respawnConnection,
            new RespawnerOptions
            {
                DbAdapter = DbAdapter.Postgres,
                SchemasToInclude = ["public"],

                // EF owns the migration history; wiping it would make the next run re-apply
                // migrations that are already present.
                TablesToIgnore = ["__EFMigrationsHistory"],
            });

        _application = NixPersistenceHost.Create(ApplicationConnectionString);
    }

    /// <summary>
    /// Deletes every row so the next test starts from an empty database.
    /// </summary>
    /// <remarks>
    /// Runs as the migrator: the runtime role can only see its own tenant's rows, so a reset
    /// performed as <c>nix_app</c> would leave the other tenant's data behind - the exact
    /// cross-test contamination the reset exists to prevent.
    /// </remarks>
    /// <returns>A task that completes when the database is empty.</returns>
    public async Task ResetAsync()
    {
        if (_respawner is null || _respawnConnection is null)
        {
            throw new InvalidOperationException("The fixture has not been initialised.");
        }

        await _respawner.ResetAsync(_respawnConnection);
    }

    /// <summary>
    /// Reads the statements Postgres logged since <paramref name="since"/>.
    /// </summary>
    /// <param name="since">The UTC instant to read from.</param>
    /// <returns>The log lines, stdout and stderr combined.</returns>
    /// <remarks>
    /// Postgres writes its statement log to stderr. Both streams are returned so a change in the
    /// image's logging configuration cannot make an assertion silently vacuous - the test that
    /// uses this asserts the lines it expects are present, not merely that nothing bad appeared.
    /// </remarks>
    public async Task<IReadOnlyList<string>> ServerLogLinesSinceAsync(DateTime since)
    {
        var (standardOut, standardError) = await _container.GetLogsAsync(since, timestampsEnabled: false);

        return string.Concat(standardOut, "\n", standardError)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    /// <summary>Opens a connection as the schema-owning role.</summary>
    /// <returns>An open connection; the caller disposes it.</returns>
    public async Task<NpgsqlConnection> OpenMigratorConnectionAsync()
    {
        var connection = new NpgsqlConnection(MigratorConnectionString);
        await connection.OpenAsync();
        return connection;
    }

    /// <summary>Opens a connection as the runtime role.</summary>
    /// <returns>An open connection; the caller disposes it.</returns>
    public async Task<NpgsqlConnection> OpenApplicationConnectionAsync()
    {
        var connection = new NpgsqlConnection(ApplicationConnectionString);
        await connection.OpenAsync();
        return connection;
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (_application is not null)
        {
            await _application.DisposeAsync();
        }

        if (_respawnConnection is not null)
        {
            await _respawnConnection.DisposeAsync();
        }

        await _container.DisposeAsync();
    }

    private static string ConnectionStringFor(string host, int port, string username, string password, string database) =>
        new NpgsqlConnectionStringBuilder
        {
            Host = host,
            Port = port,
            Username = username,
            Password = password,
            Database = database,
            IncludeErrorDetail = true,
        }.ConnectionString;

    private static async Task ExecuteAsync(NpgsqlConnection connection, string sql)
    {
#pragma warning disable CA2100 // Review SQL queries for security vulnerabilities
        // Justification: harness DDL, all of it const strings in this assembly.
        await using var command = new NpgsqlCommand(sql, connection);
#pragma warning restore CA2100
        await command.ExecuteNonQueryAsync();
    }

    private static async Task ProvisionClusterAsync(string superuserConnectionString, string host, int port)
    {
        var maintenance = new NpgsqlConnection(superuserConnectionString);
        await using (maintenance.ConfigureAwait(false))
        {
            await maintenance.OpenAsync();
            await ExecuteAsync(maintenance, NixDatabaseRoles.CreateRolesSql);

            // CREATE DATABASE cannot run inside a transaction block, hence its own statement.
            await ExecuteAsync(
                maintenance,
                $"CREATE DATABASE {NixDatabaseRoles.Database} OWNER {NixDatabaseRoles.Migrator}");
        }

        var applicationDatabase = new NpgsqlConnection(
            ConnectionStringFor(host, port, SuperuserName, SuperuserPassword, NixDatabaseRoles.Database));
        await using (applicationDatabase.ConfigureAwait(false))
        {
            await applicationDatabase.OpenAsync();
            await ExecuteAsync(applicationDatabase, NixDatabaseRoles.ConfigureDatabaseSql);
        }
    }

    private async Task ApplyProbeSchemaAsync()
    {
        var connection = await OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await ExecuteAsync(connection, RlsProbeSchema.CreateSql);
        }
    }
}
