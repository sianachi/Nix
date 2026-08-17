-- Shipped workspace-template presets.
--
-- Run after a deployment has inserted its workspaces, principals, and workspace
-- memberships. The schema migration also runs this reconciliation
-- for upgrades, but an empty database has no workspaces at migration time.
--
-- Idempotent: stable catalog and item identities plus ON CONFLICT guards make
-- this safe after every workspace seed. Custom deployment seeds should invoke
-- this same file after inserting their workspace members.

DO $$
BEGIN
    IF to_regclass('public.workspace_template') IS NULL THEN
        RAISE EXCEPTION
            'the template schema is not present; run the migrator before provisioning presets';
    END IF;
END
$$;

WITH actor_candidate AS (
    SELECT member.tenant_id,
           member.workspace_id,
           member.subject_id AS actor_id,
           CASE member.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END AS role_rank,
           0 AS membership_rank,
           member.granted_at
      FROM workspace_member member
      JOIN principal actor
        ON actor.tenant_id = member.tenant_id
       AND actor.principal_id = member.subject_id
       AND actor.status = 'active'
     WHERE member.subject_type = 'principal'

    UNION ALL

    SELECT member.tenant_id,
           member.workspace_id,
           membership.principal_id AS actor_id,
           CASE member.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END AS role_rank,
           1 AS membership_rank,
           member.granted_at
      FROM workspace_member member
      JOIN group_membership membership
        ON membership.tenant_id = member.tenant_id
       AND membership.group_id = member.subject_id
      JOIN principal actor
        ON actor.tenant_id = membership.tenant_id
       AND actor.principal_id = membership.principal_id
       AND actor.status = 'active'
     WHERE member.subject_type = 'group'
),
workspace_actor AS (
    SELECT DISTINCT ON (candidate.tenant_id, candidate.workspace_id)
           candidate.tenant_id,
           candidate.workspace_id,
           candidate.actor_id
      FROM actor_candidate candidate
     ORDER BY candidate.tenant_id,
              candidate.workspace_id,
              candidate.role_rank,
              candidate.membership_rank,
              candidate.granted_at,
              candidate.actor_id
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
  FROM workspace_actor actor
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
