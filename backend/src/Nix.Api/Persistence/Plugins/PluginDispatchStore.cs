using System.Security.Cryptography;
using System.Text;
using Nix.Domain.Plugins;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Plugins;

/// <summary>Cross-tenant worker access through the three narrow plugin security-definer functions.</summary>
public sealed class PluginDispatchStore(NpgsqlDataSource dataSource)
{
    private const string PrepareSql =
        "SELECT * FROM nix_prepare_plugin_event(@event_id, @tenant_id, @workspace_id, @item_id, @kind, @aggregate_version, @causation_id, @causation_depth, @lease_seconds)";
    private const string HostCallSql =
        "SELECT * FROM nix_plugin_read_item_metadata(@invocation_id, @item_id)";
    private const string CompleteSql =
        "SELECT * FROM nix_complete_plugin_invocation(@invocation_id, @succeeded, @retryable, @error_code, @error_detail, @fingerprint)";

    /// <summary>Deduplicates one event and leases pending installation invocations.</summary>
    public async ValueTask<PluginPreparationResult> PrepareAsync(
        PluginEventEnvelope envelope,
        int leaseSeconds,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
#pragma warning disable CA2100 // Justification: every statement is a private constant; all values are bound parameters.
            var command = new NpgsqlCommand(PrepareSql, connection);
#pragma warning restore CA2100
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(Uuid("event_id", envelope.EventId));
                command.Parameters.Add(Uuid("tenant_id", envelope.TenantId));
                command.Parameters.Add(Uuid("workspace_id", envelope.WorkspaceId));
                command.Parameters.Add(NullableUuid("item_id", envelope.ItemId));
                command.Parameters.Add(Text("kind", envelope.Kind));
                command.Parameters.Add(NullableBigint("aggregate_version", envelope.AggregateVersion));
                command.Parameters.Add(Uuid("causation_id", envelope.CausationId));
                command.Parameters.Add(Integer("causation_depth", envelope.CausationDepth));
                command.Parameters.Add(Integer("lease_seconds", leaseSeconds));
                var plans = new List<PluginInvocationPreparation>();
                var outcome = PluginPreparationOutcome.Settled;
                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        outcome = ParsePreparationOutcome(reader.GetString(0));
                        if (outcome != PluginPreparationOutcome.Prepared)
                        {
                            continue;
                        }
                        plans.Add(new PluginInvocationPreparation(
                            PluginInvocationId.From(reader.GetGuid(1)),
                            PluginInstallationId.From(reader.GetGuid(2)),
                            reader.GetString(3),
                            reader.GetString(4),
                            reader.GetString(5),
                            reader.GetString(6),
                            reader.GetString(7),
                            reader.GetInt64(8),
                            await reader.GetFieldValueAsync<byte[]>(9, cancellationToken).ConfigureAwait(false),
                            await reader.GetFieldValueAsync<byte[]>(10, cancellationToken).ConfigureAwait(false),
                            await reader.GetFieldValueAsync<string[]>(11, cancellationToken).ConfigureAwait(false),
                            reader.GetInt32(12),
                            await reader.GetFieldValueAsync<DateTimeOffset>(13, cancellationToken).ConfigureAwait(false),
                            new PluginEventEnvelope(
                                envelope.EventId,
                                envelope.TenantId,
                                reader.GetGuid(14),
                                await reader.IsDBNullAsync(15, cancellationToken).ConfigureAwait(false)
                                    ? null
                                    : reader.GetGuid(15),
                                reader.GetString(16),
                                await reader.IsDBNullAsync(17, cancellationToken).ConfigureAwait(false)
                                    ? null
                                    : reader.GetInt64(17),
                                reader.GetGuid(18),
                                reader.GetInt32(19))));
                    }
                }
                return new PluginPreparationResult(outcome, plans);
            }
        }
    }

    /// <summary>Executes the exact granted read-item-metadata host call.</summary>
    public async ValueTask<PluginItemMetadata?> ReadItemMetadataAsync(
        PluginInvocationId invocationId,
        Guid itemId,
        CancellationToken cancellationToken)
    {
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
#pragma warning disable CA2100 // Justification: every statement is a private constant; all values are bound parameters.
            var command = new NpgsqlCommand(HostCallSql, connection);
#pragma warning restore CA2100
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(Uuid("invocation_id", invocationId.Value));
                command.Parameters.Add(Uuid("item_id", itemId));
                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        return null;
                    }
                    return new PluginItemMetadata(
                        reader.GetGuid(0),
                        reader.GetGuid(1),
                        await reader.IsDBNullAsync(2, cancellationToken).ConfigureAwait(false)
                            ? null
                            : reader.GetGuid(2),
                        reader.GetString(3),
                        await reader.IsDBNullAsync(4, cancellationToken).ConfigureAwait(false)
                            ? null
                            : reader.GetString(4),
                        reader.GetString(5),
                        await reader.GetFieldValueAsync<DateTimeOffset>(6, cancellationToken).ConfigureAwait(false),
                        reader.GetGuid(7),
                        reader.GetInt32(8));
                }
            }
        }
    }

    /// <summary>Records an idempotent terminal or retryable attempt report.</summary>
    public async ValueTask<PluginCompletionResult> CompleteAsync(
        PluginInvocationId invocationId,
        bool succeeded,
        bool retryable,
        string? errorCode,
        string? errorDetail,
        CancellationToken cancellationToken)
    {
        var fingerprintSource = string.Join('\n', succeeded, retryable, errorCode, errorDetail);
        var fingerprint = SHA256.HashData(Encoding.UTF8.GetBytes(fingerprintSource)); // byte[]: required by the cryptographic hash API and bounded by the completion contract.
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
#pragma warning disable CA2100 // Justification: every statement is a private constant; all values are bound parameters.
            var command = new NpgsqlCommand(CompleteSql, connection);
#pragma warning restore CA2100
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(Uuid("invocation_id", invocationId.Value));
                command.Parameters.Add(Boolean("succeeded", succeeded));
                command.Parameters.Add(Boolean("retryable", retryable));
                command.Parameters.Add(NullableText("error_code", errorCode));
                command.Parameters.Add(NullableText("error_detail", errorDetail));
                command.Parameters.Add(new NpgsqlParameter<byte[]>("fingerprint", NpgsqlDbType.Bytea)
                {
                    TypedValue = fingerprint,
                });
                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        throw new InvalidOperationException("The plugin completion function returned no outcome.");
                    }
                    return new PluginCompletionResult(
                        ParseCompletionOutcome(reader.GetString(0)),
                        reader.GetBoolean(1));
                }
            }
        }
    }

    private static PluginPreparationOutcome ParsePreparationOutcome(string value) => value switch
    {
        "prepared" => PluginPreparationOutcome.Prepared,
        "settled" => PluginPreparationOutcome.Settled,
        "busy" => PluginPreparationOutcome.Busy,
        "not_found" => PluginPreparationOutcome.NotFound,
        "conflict" => PluginPreparationOutcome.Conflict,
        "invalid" => PluginPreparationOutcome.Invalid,
        _ => throw new InvalidOperationException($"Unknown plugin preparation outcome '{value}'."),
    };

    private static PluginCompletionOutcome ParseCompletionOutcome(string value) => value switch
    {
        "applied" => PluginCompletionOutcome.Applied,
        "replayed" => PluginCompletionOutcome.Replayed,
        "not_found" => PluginCompletionOutcome.NotFound,
        "conflict" => PluginCompletionOutcome.Conflict,
        "invalid" => PluginCompletionOutcome.Invalid,
        _ => throw new InvalidOperationException($"Unknown plugin completion outcome '{value}'."),
    };

    private static NpgsqlParameter<Guid> Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { TypedValue = value };
    private static NpgsqlParameter<int> Integer(string name, int value) =>
        new(name, NpgsqlDbType.Integer) { TypedValue = value };
    private static NpgsqlParameter<bool> Boolean(string name, bool value) =>
        new(name, NpgsqlDbType.Boolean) { TypedValue = value };
    private static NpgsqlParameter<string> Text(string name, string value) =>
        new(name, NpgsqlDbType.Text) { TypedValue = value };
    private static NpgsqlParameter NullableUuid(string name, Guid? value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value is null ? DBNull.Value : value.Value };
    private static NpgsqlParameter NullableBigint(string name, long? value) =>
        new(name, NpgsqlDbType.Bigint) { Value = value is null ? DBNull.Value : value.Value };
    private static NpgsqlParameter NullableText(string name, string? value) =>
        new(name, NpgsqlDbType.Text) { Value = value is null ? DBNull.Value : value };
}

/// <summary>Identifier-only event metadata accepted from RabbitMQ.</summary>
public sealed record PluginEventEnvelope(
    Guid EventId,
    Guid TenantId,
    Guid WorkspaceId,
    Guid? ItemId,
    string Kind,
    long? AggregateVersion,
    Guid CausationId,
    int CausationDepth);

public enum PluginPreparationOutcome { Prepared, Settled, Busy, NotFound, Conflict, Invalid }
public sealed record PluginPreparationResult(PluginPreparationOutcome Outcome, IReadOnlyList<PluginInvocationPreparation> Plans);
public sealed record PluginInvocationPreparation(
    PluginInvocationId InvocationId,
    PluginInstallationId InstallationId,
    string PublisherId,
    string ComponentId,
    string Version,
    string ObjectKey,
    string Sha256,
    long ByteLength,
    ReadOnlyMemory<byte> PublicKey,
    ReadOnlyMemory<byte> Signature,
    IReadOnlyList<string> Capabilities,
    int Attempt,
    DateTimeOffset LeaseUntil,
    PluginEventEnvelope Event);
public sealed record PluginItemMetadata(
    Guid ItemId,
    Guid WorkspaceId,
    Guid? ParentId,
    string ItemType,
    string? Title,
    string LifecycleState,
    DateTimeOffset LastModifiedAt,
    Guid CausationId,
    int CausationDepth);
public enum PluginCompletionOutcome { Applied, Replayed, NotFound, Conflict, Invalid }
public sealed record PluginCompletionResult(PluginCompletionOutcome Outcome, bool ShouldRequeue);
