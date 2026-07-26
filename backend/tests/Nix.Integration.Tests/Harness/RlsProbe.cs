using Nix.Infrastructure.Persistence.Sql;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Harness;

/// <summary>
/// Seeding and reading helpers for the RLS probe table.
/// </summary>
internal static class RlsProbe
{
    /// <summary>
    /// Seeds one row as the migrator, on behalf of any tenant.
    /// </summary>
    /// <remarks>
    /// Seeding runs as the migrator precisely because it bypasses RLS: the tests need both
    /// tenants' rows to exist before either tenant looks, and the runtime role - correctly -
    /// cannot write a row for a tenant it is not scoped to. That restriction is itself asserted
    /// in <c>RlsIsolationTests</c>.
    /// </remarks>
    /// <param name="fixture">The database fixture.</param>
    /// <param name="tenantId">The tenant the row belongs to.</param>
    /// <param name="label">A label unique within the test.</param>
    /// <param name="payload">Binary payload, for the streaming read path.</param>
    /// <returns>The new row's id.</returns>
    public static async Task<Guid> SeedAsync(
        NixPostgresFixture fixture,
        Guid tenantId,
        string label,
        ReadOnlyMemory<byte> payload = default)
    {
        var id = Guid.NewGuid();

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
#pragma warning disable CA2100 // Review SQL queries for security vulnerabilities
            // Justification: const statement text from RlsProbeSchema; values are parameters.
            var command = new NpgsqlCommand(RlsProbeSchema.InsertSql, connection);
#pragma warning restore CA2100
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(new NpgsqlParameter<Guid>("id", id));
                command.Parameters.Add(new NpgsqlParameter<Guid>("tenant_id", tenantId));
                command.Parameters.Add(new NpgsqlParameter("workspace_id", NpgsqlDbType.Uuid) { Value = DBNull.Value });
                command.Parameters.Add(new NpgsqlParameter<string>("label", label));
                command.Parameters.Add(new NpgsqlParameter("payload", NpgsqlDbType.Bytea)
                {
                    Value = payload.ToArray(), // byte[]: Npgsql binds bytea parameters from arrays; test-only seed data of a few bytes.
                });

                await command.ExecuteNonQueryAsync();
            }
        }

        return id;
    }

    /// <summary>
    /// Reads every probe row the current unit of work is allowed to see.
    /// </summary>
    /// <param name="work">A started, tenant-scoped unit of work.</param>
    /// <returns>The visible rows.</returns>
    public static async Task<IReadOnlyList<ProbeRow>> ReadVisibleAsync(NixUnitOfWork work)
    {
        var rows = new List<ProbeRow>();
        await foreach (var row in work.Sql.QueryAsync<ProbeRow, ProbeRowMapper>(
            RlsProbeSchema.SelectVisibleSql,
            default))
        {
            rows.Add(row);
        }

        return rows;
    }

    /// <summary>One probe row.</summary>
    /// <param name="Id">The row id.</param>
    /// <param name="TenantId">The owning tenant.</param>
    /// <param name="Label">The row label.</param>
    public readonly record struct ProbeRow(Guid Id, Guid TenantId, string Label);

    /// <summary>
    /// Maps a probe row. A struct mapper, which is the shape hot-path mappers take: passed as a
    /// generic type argument it is monomorphised, so the per-row call allocates nothing.
    /// </summary>
    public readonly struct ProbeRowMapper : INixRowMapper<ProbeRow>
    {
        /// <inheritdoc />
        public ProbeRow Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            // Left to right, once each: the reader is in sequential-access mode.
            return new ProbeRow(reader.GetGuid(0), reader.GetGuid(1), reader.GetString(2));
        }
    }
}
