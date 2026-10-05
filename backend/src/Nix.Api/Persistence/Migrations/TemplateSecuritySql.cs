namespace Nix.Persistence.Migrations;

/// <summary>Security, bounds, and shipped catalog data for the workspace-template migration.</summary>
public static class TemplateSecuritySql
{
    private const string ApplicationRole = "nix_app";

    private static readonly string[] Tables =
    [
        "workspace_template",
        "template_operation",
        "template_operation_item",
        "template_application",
        "template_application_item",
    ];

    /// <summary>Applies forced RLS, explicit grants, vocabulary bounds, and seed templates.</summary>
    /// <param name="emit">Sends a SQL batch to the migration.</param>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        foreach (var table in Tables)
        {
            emit($"""
                ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
                ALTER TABLE {table} FORCE ROW LEVEL SECURITY;

                DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};
                CREATE POLICY {table}_tenant_isolation ON {table}
                    USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                    WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);

                REVOKE ALL ON {table} FROM PUBLIC;
                GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {ApplicationRole};
                """);
        }

        emit("""
            ALTER TABLE item ADD CONSTRAINT item_template_identity_complete
                CHECK ((template_id IS NULL) = (template_source_id IS NULL));

            ALTER TABLE workspace_template ADD CONSTRAINT workspace_template_origin_known
                CHECK (origin IN ('seed', 'user', 'managed'));
            ALTER TABLE workspace_template ADD CONSTRAINT workspace_template_state_known
                CHECK (state IN ('provisioning', 'active', 'inactive'));
            ALTER TABLE workspace_template ADD CONSTRAINT workspace_template_revision_positive
                CHECK (revision > 0);

            ALTER TABLE template_operation ADD CONSTRAINT template_operation_kind_known
                CHECK (kind IN ('capture', 'import', 'edit'));
            ALTER TABLE template_operation ADD CONSTRAINT template_operation_state_known
                CHECK (state IN ('provisioning', 'active', 'aborted'));
            ALTER TABLE template_application ADD CONSTRAINT template_application_mode_known
                CHECK (mode IN ('merge', 'create'));
            ALTER TABLE template_application ADD CONSTRAINT template_application_state_known
                CHECK (state IN ('provisioning', 'active', 'aborted'));
            """);

        SeedPresets(emit);
    }

    /// <summary>Removes every hidden template envelope before the model loses its hiding columns.</summary>
    /// <param name="emit">Sends a SQL batch to the migration.</param>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        foreach (var table in Tables)
        {
            emit($"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY;");
        }

        emit("""
            UPDATE workspace_template
               SET root_item_id = NULL,
                   pending_root_item_id = NULL;

            DELETE FROM template_application_item;
            DELETE FROM template_operation_item;
            DELETE FROM template_application;
            DELETE FROM template_operation;

            ALTER TABLE item_closure DISABLE ROW LEVEL SECURITY;
            ALTER TABLE item DISABLE ROW LEVEL SECURITY;
            DELETE FROM item_closure
             WHERE ancestor_id IN (SELECT id FROM item WHERE template_id IS NOT NULL)
                OR descendant_id IN (SELECT id FROM item WHERE template_id IS NOT NULL);
            DELETE FROM item WHERE template_id IS NOT NULL;
            ALTER TABLE item_closure ENABLE ROW LEVEL SECURITY;
            ALTER TABLE item_closure FORCE ROW LEVEL SECURITY;
            ALTER TABLE item ENABLE ROW LEVEL SECURITY;
            ALTER TABLE item FORCE ROW LEVEL SECURITY;

            DELETE FROM workspace_template;
            """);
    }

    private static void SeedPresets(Action<string> emit) =>
        emit("""
            WITH direct_actor AS (
                SELECT DISTINCT ON (member.workspace_id)
                       member.tenant_id,
                       member.workspace_id,
                       member.subject_id AS actor_id
                  FROM workspace_member member
                 WHERE member.subject_type = 'principal'
                 ORDER BY member.workspace_id,
                          CASE member.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
                          member.granted_at
            ),
            preset(stable_key, title, description, schema_json, views_json) AS (
                VALUES
                (
                    'seed.kanban',
                    'Kanban',
                    'A To do, Doing, and Done workflow.',
                    '{"inherit":true,"properties":[{"key":"status","label":"Status","type":"select","options":["To do","Doing","Done"],"required":false}]}'::jsonb,
                    '{"views":[{"id":"board","name":"Board","kind":"board","columns":["title","status"],"groupBy":"status","groupOrder":["To do","Doing","Done"],"sortDescending":false}],"default":"board"}'::jsonb
                ),
                (
                    'seed.calendar',
                    'Calendar',
                    'A week calendar backed by a Starts timestamp.',
                    '{"inherit":true,"properties":[{"key":"starts","label":"Starts","type":"timestamp","required":false}]}'::jsonb,
                    '{"views":[{"id":"calendar","name":"Calendar","kind":"calendar","columns":["title","starts"],"dateProperty":"starts","mode":"week","sortDescending":false}],"default":"calendar"}'::jsonb
                ),
                (
                    'seed.list',
                    'List',
                    'A list with Done and Owner fields.',
                    '{"inherit":true,"properties":[{"key":"done","label":"Done","type":"checkbox","required":false},{"key":"owner","label":"Owner","type":"text","required":false}]}'::jsonb,
                    '{"views":[{"id":"list","name":"All","kind":"list","columns":["title","done","owner"],"sortDescending":false}],"default":"list"}'::jsonb
                )
            )
            INSERT INTO workspace_template (
                template_id, tenant_id, workspace_id, stable_key, profile_key, origin, title, description,
                include_body, include_children, state, revision, created_by, last_modified_by,
                created_at, last_modified_at)
            SELECT (
                       substr(md5(actor.workspace_id::text || ':' || preset.stable_key || ':template'), 1, 12)
                       || '4'
                       || substr(md5(actor.workspace_id::text || ':' || preset.stable_key || ':template'), 14, 3)
                       || '8'
                       || substr(md5(actor.workspace_id::text || ':' || preset.stable_key || ':template'), 18, 15)
                   )::uuid,
                   actor.tenant_id,
                   actor.workspace_id,
                   preset.stable_key,
                   preset.stable_key,
                   'seed',
                   preset.title,
                   preset.description,
                   false,
                   false,
                   'active',
                   1,
                   actor.actor_id,
                   actor.actor_id,
                   now(),
                   now()
              FROM direct_actor actor
              CROSS JOIN preset
            ON CONFLICT (tenant_id, workspace_id, stable_key) DO NOTHING;

            WITH preset(stable_key, title, schema_json, views_json) AS (
                VALUES
                ('seed.kanban', 'Kanban',
                 '{"inherit":true,"properties":[{"key":"status","label":"Status","type":"select","options":["To do","Doing","Done"],"required":false}]}'::jsonb,
                 '{"views":[{"id":"board","name":"Board","kind":"board","columns":["title","status"],"groupBy":"status","groupOrder":["To do","Doing","Done"],"sortDescending":false}],"default":"board"}'::jsonb),
                ('seed.calendar', 'Calendar',
                 '{"inherit":true,"properties":[{"key":"starts","label":"Starts","type":"timestamp","required":false}]}'::jsonb,
                 '{"views":[{"id":"calendar","name":"Calendar","kind":"calendar","columns":["title","starts"],"dateProperty":"starts","mode":"week","sortDescending":false}],"default":"calendar"}'::jsonb),
                ('seed.list', 'List',
                 '{"inherit":true,"properties":[{"key":"done","label":"Done","type":"checkbox","required":false},{"key":"owner","label":"Owner","type":"text","required":false}]}'::jsonb,
                 '{"views":[{"id":"list","name":"All","kind":"list","columns":["title","done","owner"],"sortDescending":false}],"default":"list"}'::jsonb)
            )
            INSERT INTO item (
                id, tenant_id, workspace_id, type, parent_id, seq, properties, schema, views,
                template_id, template_source_id, lifecycle_state, created_by, last_modified_by,
                created_at, last_modified_at)
            SELECT (
                       substr(md5(catalog.workspace_id::text || ':' || catalog.stable_key || ':root'), 1, 12)
                       || '4'
                       || substr(md5(catalog.workspace_id::text || ':' || catalog.stable_key || ':root'), 14, 3)
                       || '8'
                       || substr(md5(catalog.workspace_id::text || ':' || catalog.stable_key || ':root'), 18, 15)
                   )::uuid,
                   catalog.tenant_id,
                   catalog.workspace_id,
                   'note',
                   NULL,
                   0,
                   jsonb_build_object('title', preset.title),
                   preset.schema_json,
                   preset.views_json,
                   catalog.template_id,
                   (
                       substr(md5(catalog.stable_key || ':source-root'), 1, 12)
                       || '4'
                       || substr(md5(catalog.stable_key || ':source-root'), 14, 3)
                       || '8'
                       || substr(md5(catalog.stable_key || ':source-root'), 18, 15)
                   )::uuid,
                   'active',
                   catalog.created_by,
                   catalog.created_by,
                   catalog.created_at,
                   catalog.created_at
              FROM workspace_template catalog
              JOIN preset ON preset.stable_key = catalog.stable_key
             WHERE catalog.origin = 'seed'
               AND catalog.root_item_id IS NULL
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth)
            SELECT item.tenant_id, item.workspace_id, item.id, item.id, 0
              FROM item
             WHERE item.template_id IS NOT NULL
            ON CONFLICT (ancestor_id, descendant_id) DO NOTHING;

            UPDATE workspace_template catalog
               SET root_item_id = item.id
              FROM item
             WHERE item.template_id = catalog.template_id
               AND item.parent_id IS NULL
               AND catalog.origin = 'seed'
               AND catalog.root_item_id IS NULL;
            """);
}
