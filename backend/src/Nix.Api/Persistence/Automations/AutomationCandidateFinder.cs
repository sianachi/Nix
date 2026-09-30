using Nix.Abstractions.Automations;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Automations;

/// <summary>
/// Calls the SECURITY DEFINER finders in <c>AutomationSecuritySql</c> directly against the pool,
/// exactly like <see cref="Nix.Persistence.Scheduling.ReminderCandidateFinder"/>: no session is
/// established, and the functions cross row security only because the migrator role owns them.
/// </summary>
public sealed class AutomationCandidateFinder(NpgsqlDataSource dataSource) : IAutomationCandidateFinder
{
    public async Task<IReadOnlyList<PlannedAutomationRule>> FindPlannedRulesAsync(int limit, Guid afterId, CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        var results = new List<PlannedAutomationRule>(limit);
        var command = dataSource.CreateCommand("SELECT * FROM nix_find_planned_automation_rules(@limit, @after_id)");
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = limit });
            command.Parameters.Add(new NpgsqlParameter<Guid>("after_id", NpgsqlDbType.Uuid) { TypedValue = afterId });
            var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    var scope = await reader.IsDBNullAsync(6, cancellationToken).ConfigureAwait(false) ? (Guid?)null : reader.GetGuid(6);
                    results.Add(new PlannedAutomationRule(
                        TenantId.From(reader.GetGuid(0)),
                        reader.GetGuid(1),
                        WorkspaceId.From(reader.GetGuid(2)),
                        PrincipalId.From(reader.GetGuid(3)),
                        reader.GetString(4),
                        reader.GetString(5),
                        scope));
                }
            }
        }

        return results;
    }

    public async Task<IReadOnlyList<AutomationDateCandidate>> FindDateCandidatesAsync(
        TenantId tenantId, Guid ruleId, DateOnly firstDay, DateOnly lastDay, int limit, Guid afterId, CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        var results = new List<AutomationDateCandidate>(limit);
        var command = dataSource.CreateCommand(
            "SELECT * FROM nix_find_automation_date_candidates(@tenant_id, @rule_id, @from, @to, @limit, @after_id)");
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(new NpgsqlParameter<Guid>("tenant_id", NpgsqlDbType.Uuid) { TypedValue = tenantId.Value });
            command.Parameters.Add(new NpgsqlParameter<Guid>("rule_id", NpgsqlDbType.Uuid) { TypedValue = ruleId });
            command.Parameters.Add(new NpgsqlParameter<DateOnly>("from", NpgsqlDbType.Date) { TypedValue = firstDay });
            command.Parameters.Add(new NpgsqlParameter<DateOnly>("to", NpgsqlDbType.Date) { TypedValue = lastDay });
            command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = limit });
            command.Parameters.Add(new NpgsqlParameter<Guid>("after_id", NpgsqlDbType.Uuid) { TypedValue = afterId });
            var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    var value = await reader.IsDBNullAsync(1, cancellationToken).ConfigureAwait(false) ? null : reader.GetString(1);
                    results.Add(new AutomationDateCandidate(reader.GetGuid(0), value));
                }
            }
        }

        return results;
    }
}
