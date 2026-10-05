using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Automations;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Configurations;

/// <summary>Maps <see cref="AutomationRule"/> to <c>automation_rule</c>.</summary>
internal sealed class AutomationRuleConfiguration : IEntityTypeConfiguration<AutomationRule>
{
    public void Configure(EntityTypeBuilder<AutomationRule> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.AutomationRule, table => table.HasCheckConstraint(
            "automation_rule_bounded",
            "trigger_type IN ('schedule', 'date_arrives', 'property_changed')"
                + " AND char_length(name) BETWEEN 1 AND 200"
                + " AND (trigger_type = 'property_changed') = (watch_key IS NOT NULL)"
                + " AND jsonb_typeof(actions) = 'array' AND jsonb_typeof(conditions) = 'array'"
                + " AND octet_length(trigger::text) <= 4096 AND octet_length(actions::text) <= 16384"
                + " AND octet_length(conditions::text) <= 8192"
                + " AND consecutive_failures >= 0"));
        builder.HasKey(row => row.Id);
        builder.Property(row => row.Id).HasColumnName("id");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(row => row.OwnerPrincipalId).HasColumnName("owner_principal_id");
        builder.Property(row => row.Name).HasColumnName("name").HasMaxLength(200).IsRequired();
        builder.Property(row => row.Enabled).HasColumnName("enabled");
        builder.Property(row => row.ScopeItemId).HasColumnName("scope_item_id");
        builder.Property(row => row.TriggerType).HasColumnName("trigger_type").HasMaxLength(32).IsRequired();
        builder.Property(row => row.WatchKey).HasColumnName("watch_key").HasMaxLength(128);
        builder.Property(row => row.Trigger).HasColumnName("trigger").HasColumnType("jsonb").IsRequired();
        builder.Property(row => row.Conditions).HasColumnName("conditions").HasColumnType("jsonb")
            .HasDefaultValueSql("'[]'::jsonb").IsRequired();
        builder.Property(row => row.Actions).HasColumnName("actions").HasColumnType("jsonb").IsRequired();
        builder.Property(row => row.SchemaVersion).HasColumnName("schema_version").HasDefaultValue((short)1);
        builder.Property(row => row.Revision).HasColumnName("revision");
        builder.Property(row => row.ConsecutiveFailures).HasColumnName("consecutive_failures").HasDefaultValue(0);
        builder.Property(row => row.DisabledReason).HasColumnName("disabled_reason").HasMaxLength(64);
        builder.Property(row => row.LastRunAt).HasColumnName("last_run_at");
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");
        builder.Property(row => row.UpdatedAt).HasColumnName("updated_at");

        builder.HasAlternateKey(row => new { row.TenantId, row.Id });

        // A rule is its owner's private state: it goes when they are purged.
        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.OwnerPrincipalId })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Workspace>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.WorkspaceId })
            .HasPrincipalKey(workspace => new { workspace.TenantId, workspace.Id })
            .OnDelete(DeleteBehavior.Cascade);

        // Cascade, never SET NULL: a rule whose scope was purged must not silently widen to the
        // whole workspace.
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.ScopeItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);

        // The owner's list, and the per-owner-per-workspace ceiling count.
        builder.HasIndex(row => new { row.TenantId, row.OwnerPrincipalId, row.WorkspaceId, row.CreatedAt })
            .HasDatabaseName("ix_automation_rule_owner");

        // The property feed's one probe per changed item row.
        builder.HasIndex(row => new { row.TenantId, row.WorkspaceId })
            .HasFilter("enabled AND trigger_type = 'property_changed'")
            .HasDatabaseName("ix_automation_rule_property_watch");

        // The scope foreign key's own index, named explicitly rather than left to the convention.
        builder.HasIndex(row => new { row.TenantId, row.ScopeItemId })
            .HasDatabaseName("ix_automation_rule_scope_item");

        // The planner's keyset over every planned rule, across tenants.
        builder.HasIndex(row => row.Id)
            .HasFilter("enabled AND trigger_type IN ('schedule', 'date_arrives')")
            .HasDatabaseName("ix_automation_rule_planned");
    }
}

/// <summary>Maps <see cref="AutomationRun"/> to <c>automation_run</c>.</summary>
internal sealed class AutomationRunConfiguration : IEntityTypeConfiguration<AutomationRun>
{
    public void Configure(EntityTypeBuilder<AutomationRun> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.AutomationRun, table => table.HasCheckConstraint(
            "automation_run_bounded",
            "origin IN ('schedule', 'date', 'property', 'manual')"
                + " AND status IN ('succeeded', 'noop', 'skipped', 'failed', 'throttled', 'suppressed')"
                + " AND depth >= 0 AND char_length(trigger_key) <= 200"
                + " AND (detail IS NULL OR octet_length(detail::text) <= 2048)"));
        builder.HasKey(row => row.Id);
        builder.Property(row => row.Id).HasColumnName("id");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.RuleId).HasColumnName("rule_id");
        builder.Property(row => row.OwnerPrincipalId).HasColumnName("owner_principal_id");
        builder.Property(row => row.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(row => row.ItemId).HasColumnName("item_id");
        builder.Property(row => row.TriggerKey).HasColumnName("trigger_key").HasMaxLength(200).IsRequired();
        builder.Property(row => row.Origin).HasColumnName("origin").HasMaxLength(16)
            .HasConversion(origin => AutomationStorage.ToText(origin), text => AutomationStorage.OriginFromText(text))
            .IsRequired();
        builder.Property(row => row.Depth).HasColumnName("depth");
        builder.Property(row => row.Status).HasColumnName("status").HasMaxLength(16)
            .HasConversion(status => AutomationStorage.ToText(status), text => AutomationStorage.StatusFromText(text))
            .IsRequired();
        builder.Property(row => row.Detail).HasColumnName("detail").HasColumnType("jsonb");
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");

        builder.HasOne<AutomationRule>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.RuleId })
            .HasPrincipalKey(rule => new { rule.TenantId, rule.Id })
            .OnDelete(DeleteBehavior.Cascade);

        // A redelivered trigger records one run.
        builder.HasIndex(row => new { row.TenantId, row.RuleId, row.TriggerKey })
            .IsUnique()
            .HasDatabaseName("ux_automation_run_rule_trigger_key");

        // The run log page, the hourly throttle count and the per-rule trim.
        builder.HasIndex(row => new { row.TenantId, row.RuleId, row.CreatedAt })
            .IsDescending(false, false, true)
            .HasDatabaseName("ix_automation_run_rule_created");

        // The hourly throttle's count of runs that did work. Partial, so a rule whose log is
        // mostly skipped or throttled rows (a burst it refused) is counted from the working rows
        // alone instead of walking every refused one in the hour.
        // Named in HasIndex itself: an unnamed HasIndex over the same columns as
        // ix_automation_run_rule_created would configure that index rather than add this one.
        builder.HasIndex(row => new { row.TenantId, row.RuleId, row.CreatedAt }, "ix_automation_run_rule_working")
            .IsDescending(false, false, true)
            .HasFilter("status IN ('succeeded', 'noop', 'failed')")
            .HasDatabaseName("ix_automation_run_rule_working");

        // nix_purge_automation_runs, across every tenant by age alone.
        builder.HasIndex(row => row.CreatedAt).HasDatabaseName("ix_automation_run_created_at");
    }
}

/// <summary>Maps <see cref="AutomationItemState"/> to <c>automation_item_state</c>.</summary>
internal sealed class AutomationItemStateConfiguration : IEntityTypeConfiguration<AutomationItemState>
{
    public void Configure(EntityTypeBuilder<AutomationItemState> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.AutomationItemState);
        builder.HasKey(row => new { row.TenantId, row.RuleId, row.ItemId });
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.RuleId).HasColumnName("rule_id");
        builder.Property(row => row.ItemId).HasColumnName("item_id");
        builder.Property(row => row.OwnerPrincipalId).HasColumnName("owner_principal_id");
        builder.Property(row => row.LastValueHash).HasColumnName("last_value_hash").HasMaxLength(64);
        builder.Property(row => row.LastFiredAt).HasColumnName("last_fired_at");

        builder.HasOne<AutomationRule>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.RuleId })
            .HasPrincipalKey(rule => new { rule.TenantId, rule.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.ItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasIndex(row => new { row.TenantId, row.ItemId }).HasDatabaseName("ix_automation_item_state_item");
    }
}
