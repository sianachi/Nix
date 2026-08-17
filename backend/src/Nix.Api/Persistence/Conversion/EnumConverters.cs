using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using Nix.Domain.Authorization;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Templates;

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
            ItemLifecycleState.Provisioning => "provisioning",
            _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown lifecycle state."),
        };

        private static ItemLifecycleState FromText(string text) => text switch
        {
            "active" => ItemLifecycleState.Active,
            "deleted" => ItemLifecycleState.Deleted,
            "purged" => ItemLifecycleState.Purged,
            "provisioning" => ItemLifecycleState.Provisioning,
            _ => throw new InvalidOperationException(
                $"The database holds '{text}' as an item lifecycle state, which this build does " +
                "not recognise. Refusing to guess: the alternative is showing purged content."),
        };
    }

    /// <summary>Maps <see cref="TemplateOrigin"/> to storage text.</summary>
    internal sealed class TemplateOriginConverter : ValueConverter<TemplateOrigin, string>
    {
        /// <summary>Initializes the converter.</summary>
        public TemplateOriginConverter()
            : base(value => ToText(value), text => FromText(text))
        {
        }

        private static string ToText(TemplateOrigin value) => value switch
        {
            TemplateOrigin.Seed => "seed",
            TemplateOrigin.User => "user",
            TemplateOrigin.Managed => "managed",
            _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown template origin."),
        };

        private static TemplateOrigin FromText(string text) => text switch
        {
            "seed" => TemplateOrigin.Seed,
            "user" => TemplateOrigin.User,
            "managed" => TemplateOrigin.Managed,
            _ => throw new InvalidOperationException($"Unknown template origin '{text}'."),
        };
    }

    /// <summary>Maps <see cref="TemplateState"/> to storage text.</summary>
    internal sealed class TemplateStateConverter : ValueConverter<TemplateState, string>
    {
        /// <summary>Initializes the converter.</summary>
        public TemplateStateConverter()
            : base(value => ToText(value), text => FromText(text))
        {
        }

        private static string ToText(TemplateState value) => value switch
        {
            TemplateState.Active => "active",
            TemplateState.Provisioning => "provisioning",
            TemplateState.Inactive => "inactive",
            _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown template state."),
        };

        private static TemplateState FromText(string text) => text switch
        {
            "active" => TemplateState.Active,
            "provisioning" => TemplateState.Provisioning,
            "inactive" => TemplateState.Inactive,
            _ => throw new InvalidOperationException($"Unknown template state '{text}'."),
        };
    }

    /// <summary>Maps <see cref="TemplateOperationKind"/> to storage text.</summary>
    internal sealed class TemplateOperationKindConverter : ValueConverter<TemplateOperationKind, string>
    {
        /// <summary>Initializes the converter.</summary>
        public TemplateOperationKindConverter()
            : base(value => ToText(value), text => FromText(text))
        {
        }

        private static string ToText(TemplateOperationKind value) => value switch
        {
            TemplateOperationKind.Capture => "capture",
            TemplateOperationKind.Import => "import",
            TemplateOperationKind.Edit => "edit",
            _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown template operation kind."),
        };

        private static TemplateOperationKind FromText(string text) => text switch
        {
            "capture" => TemplateOperationKind.Capture,
            "import" => TemplateOperationKind.Import,
            "edit" => TemplateOperationKind.Edit,
            _ => throw new InvalidOperationException($"Unknown template operation kind '{text}'."),
        };
    }

    /// <summary>Maps <see cref="TemplateOperationState"/> to storage text.</summary>
    internal sealed class TemplateOperationStateConverter : ValueConverter<TemplateOperationState, string>
    {
        /// <summary>Initializes the converter.</summary>
        public TemplateOperationStateConverter()
            : base(value => ToText(value), text => FromText(text))
        {
        }

        private static string ToText(TemplateOperationState value) => value switch
        {
            TemplateOperationState.Provisioning => "provisioning",
            TemplateOperationState.Active => "active",
            TemplateOperationState.Aborted => "aborted",
            _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown template operation state."),
        };

        private static TemplateOperationState FromText(string text) => text switch
        {
            "provisioning" => TemplateOperationState.Provisioning,
            "active" => TemplateOperationState.Active,
            "aborted" => TemplateOperationState.Aborted,
            _ => throw new InvalidOperationException($"Unknown template operation state '{text}'."),
        };
    }

    /// <summary>Maps <see cref="TemplateApplicationMode"/> to storage text.</summary>
    internal sealed class TemplateApplicationModeConverter : ValueConverter<TemplateApplicationMode, string>
    {
        /// <summary>Initializes the converter.</summary>
        public TemplateApplicationModeConverter()
            : base(value => ToText(value), text => FromText(text))
        {
        }

        private static string ToText(TemplateApplicationMode value) => value switch
        {
            TemplateApplicationMode.Merge => "merge",
            TemplateApplicationMode.Create => "create",
            _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown template application mode."),
        };

        private static TemplateApplicationMode FromText(string text) => text switch
        {
            "merge" => TemplateApplicationMode.Merge,
            "create" => TemplateApplicationMode.Create,
            _ => throw new InvalidOperationException($"Unknown template application mode '{text}'."),
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
