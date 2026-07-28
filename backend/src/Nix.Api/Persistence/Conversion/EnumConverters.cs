using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using Nix.Domain.Authorization;
using Nix.Domain.Identity;
using Nix.Domain.Items;

namespace Nix.Persistence.Conversion;

/// <summary>
/// How the domain's closed vocabularies are stored: lower-case text, mapped explicitly.
/// </summary>
/// <remarks>
/// <para>
/// <b>Text, not integers.</b> An <c>ordinal</c> column is unreadable in a psql session and turns
/// every support question into a lookup against source code; worse, reordering an enumeration
/// silently reinterprets rows already written. Text costs a few bytes and is self-describing.
/// </para>
/// <para>
/// <b>Explicit switches, not <see cref="Enum.Parse{TEnum}(string)"/>.</b> The reflective route
/// allocates on both directions of every row materialised, and these columns sit on the tables
/// read most often. A switch expression over string constants compiles to a jump table and
/// interned literals: no allocation reading, none writing.
/// </para>
/// <para>
/// <b>Unknown text throws.</b> A value the domain does not recognise means the database holds
/// something this build cannot interpret - a rolled-back deployment, a hand-edited row - and
/// guessing at it would silently downgrade an authorization decision or a lifecycle state.
/// Failing loudly is the only safe reading.
/// </para>
/// </remarks>
internal static class EnumConverters
{
    /// <summary>Maps <see cref="AclEffect"/> to <c>allow</c> or <c>deny</c>.</summary>
    internal sealed class AclEffectConverter : ValueConverter<AclEffect, string>
    {
        /// <summary>Initializes a new instance of the <see cref="AclEffectConverter"/> class.</summary>
        public AclEffectConverter()
            : base(value => ToText(value), text => FromText(text))
        {
        }

        private static string ToText(AclEffect value) => value switch
        {
            AclEffect.Allow => "allow",
            AclEffect.Deny => "deny",
            _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown ACL effect."),
        };

        private static AclEffect FromText(string text) => text switch
        {
            "allow" => AclEffect.Allow,
            "deny" => AclEffect.Deny,
            _ => throw new InvalidOperationException(
                $"The database holds '{text}' as an ACL effect, which this build does not " +
                "recognise. Refusing to guess: the alternative is resolving a deny as an allow."),
        };
    }

    /// <summary>Maps <see cref="SubjectType"/> to <c>principal</c> or <c>group</c>.</summary>
    internal sealed class SubjectTypeConverter : ValueConverter<SubjectType, string>
    {
        /// <summary>Initializes a new instance of the <see cref="SubjectTypeConverter"/> class.</summary>
        public SubjectTypeConverter()
            : base(value => ToText(value), text => FromText(text))
        {
        }

        private static string ToText(SubjectType value) => value switch
        {
            SubjectType.Principal => "principal",
            SubjectType.Group => "group",
            _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown subject type."),
        };

        private static SubjectType FromText(string text) => text switch
        {
            "principal" => SubjectType.Principal,
            "group" => SubjectType.Group,
            _ => throw new InvalidOperationException(
                $"The database holds '{text}' as a subject type, which this build does not " +
                "recognise."),
        };
    }

    /// <summary>Maps <see cref="ItemLifecycleState"/> to its lower-case name.</summary>
    internal sealed class ItemLifecycleStateConverter : ValueConverter<ItemLifecycleState, string>
    {
        /// <summary>Initializes a new instance of the <see cref="ItemLifecycleStateConverter"/> class.</summary>
        public ItemLifecycleStateConverter()
            : base(value => ToText(value), text => FromText(text))
        {
        }

        private static string ToText(ItemLifecycleState value) => value switch
        {
            ItemLifecycleState.Active => "active",
            ItemLifecycleState.Deleted => "deleted",
            ItemLifecycleState.Purged => "purged",
            _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown lifecycle state."),
        };

        private static ItemLifecycleState FromText(string text) => text switch
        {
            "active" => ItemLifecycleState.Active,
            "deleted" => ItemLifecycleState.Deleted,
            "purged" => ItemLifecycleState.Purged,
            _ => throw new InvalidOperationException(
                $"The database holds '{text}' as an item lifecycle state, which this build does " +
                "not recognise. Refusing to guess: the alternative is showing purged content."),
        };
    }

    /// <summary>Maps <see cref="PrincipalKind"/> to its lower-case name.</summary>
    internal sealed class PrincipalKindConverter : ValueConverter<PrincipalKind, string>
    {
        /// <summary>Initializes a new instance of the <see cref="PrincipalKindConverter"/> class.</summary>
        public PrincipalKindConverter()
            : base(value => ToText(value), text => FromText(text))
        {
        }

        private static string ToText(PrincipalKind value) => value switch
        {
            PrincipalKind.User => "user",
            PrincipalKind.Service => "service",
            _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown principal kind."),
        };

        private static PrincipalKind FromText(string text) => text switch
        {
            "user" => PrincipalKind.User,
            "service" => PrincipalKind.Service,
            _ => throw new InvalidOperationException(
                $"The database holds '{text}' as a principal kind, which this build does not " +
                "recognise."),
        };
    }

    /// <summary>Maps <see cref="PrincipalStatus"/> to its lower-case name.</summary>
    internal sealed class PrincipalStatusConverter : ValueConverter<PrincipalStatus, string>
    {
        /// <summary>Initializes a new instance of the <see cref="PrincipalStatusConverter"/> class.</summary>
        public PrincipalStatusConverter()
            : base(value => ToText(value), text => FromText(text))
        {
        }

        private static string ToText(PrincipalStatus value) => value switch
        {
            PrincipalStatus.Active => "active",
            PrincipalStatus.Suspended => "suspended",
            PrincipalStatus.Deprovisioned => "deprovisioned",
            _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown principal status."),
        };

        private static PrincipalStatus FromText(string text) => text switch
        {
            "active" => PrincipalStatus.Active,
            "suspended" => PrincipalStatus.Suspended,
            "deprovisioned" => PrincipalStatus.Deprovisioned,

            // Deliberately not defaulting to Active. An unreadable status must never resolve to
            // "may act": that would turn a deprovisioning this build cannot parse into access.
            _ => throw new InvalidOperationException(
                $"The database holds '{text}' as a principal status, which this build does not " +
                "recognise. Refusing to guess: the alternative is admitting a deprovisioned " +
                "principal."),
        };
    }
}
