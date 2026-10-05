using Nix.Domain.Tenancy;

namespace Nix.Domain.Plugins;

#pragma warning disable CA1819 // Justification: EF Core's PostgreSQL bytea provider requires byte[] storage for the fixed completion digest.

/// <summary>One immutable-identity, lease-bounded attempt to execute a plugin event.</summary>
public sealed class PluginInvocation
{
    /// <summary>Gets the attempt identity returned to the worker.</summary>
    public required PluginInvocationId Id { get; init; }

    /// <summary>Gets the owning tenant.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the source workspace event.</summary>
    public required Guid EventId { get; init; }

    /// <summary>Gets the target installation.</summary>
    public required PluginInstallationId InstallationId { get; init; }

    /// <summary>Gets the event workspace.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets the monotonically increasing attempt number.</summary>
    public required int Attempt { get; init; }

    /// <summary>Gets the causal root identity copied into this execution state.</summary>
    public required Guid CausationId { get; init; }

    /// <summary>Gets the causal depth copied into this execution state.</summary>
    public required int CausationDepth { get; init; }

    /// <summary>Gets the attempt lifecycle.</summary>
    public required string Status { get; set; }

    /// <summary>Gets when the worker must stop using this invocation identity.</summary>
    public required DateTimeOffset LeaseUntil { get; init; }

    /// <summary>Gets the idempotency fingerprint of a terminal report.</summary>
    public byte[]? CompletionFingerprint { get; set; }

    /// <summary>Gets whether the worker reported success.</summary>
    public bool? Succeeded { get; set; }

    /// <summary>Gets whether a failed attempt asked RabbitMQ to redeliver the event.</summary>
    public bool? Retryable { get; set; }

    /// <summary>Gets the stable failure code.</summary>
    public string? ErrorCode { get; set; }

    /// <summary>Gets the bounded safe failure detail.</summary>
    public string? ErrorDetail { get; set; }

    /// <summary>Gets when the attempt was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets when the attempt became terminal.</summary>
    public DateTimeOffset? CompletedAt { get; set; }
}
#pragma warning restore CA1819
