\set ON_ERROR_STOP on

-- Opt-in MVP-1 corpus. Fixed identifiers and upserts make reruns safe without touching other data.
-- The browser proof captures and reapplies a workspace template, so its fixed actor must retain
-- the same management capability even when a preceding real-Postgres suite has reseeded principals.
UPDATE principal
SET can_manage_templates = true
WHERE principal_id = 'a2000000-0000-4000-8000-000000000001'::uuid;

WITH constants AS (
    SELECT
        'a0000000-0000-4000-8000-000000000001'::uuid AS tenant_id,
        'a1000000-0000-4000-8000-000000000001'::uuid AS workspace_id,
        'a2000000-0000-4000-8000-000000000001'::uuid AS actor_id,
        'a6100000-0000-4000-8000-000000000001'::uuid AS root_id
)
INSERT INTO item
    (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
     purge_after, created_by, last_modified_by, created_at, last_modified_at, schema, views)
SELECT
    root_id, tenant_id, workspace_id, 'note', NULL, 900000,
    '{"title":"MVP-1 — 3,200 item stress container"}'::jsonb,
    'active', NULL, actor_id, actor_id, now(), now(),
    '{"properties":[
        {"key":"status","label":"Status","type":"select","options":["Backlog","Doing","Done"],"required":false},
        {"key":"owner","label":"Owner","type":"text","options":[],"required":false},
        {"key":"due","label":"Due","type":"date","options":[],"required":false},
        {"key":"starts","label":"Starts","type":"timestamp","options":[],"required":false},
        {"key":"ends","label":"Ends","type":"timestamp","options":[],"required":false},
        {"key":"cover","label":"Cover","type":"image","options":[],"required":false}
      ],"inherit":true}'::jsonb,
    '{"views":[
        {"id":"stress-list","name":"List","kind":"list","columns":["status","owner","due"]},
        {"id":"stress-board","name":"Board","kind":"board","groupBy":"status","groupOrder":["Backlog","Doing","Done"],"columns":["owner","due"]},
        {"id":"stress-gallery","name":"Gallery","kind":"gallery","coverProperty":"cover","cardSize":"small","columns":["status","owner"]},
        {"id":"stress-calendar","name":"Calendar","kind":"calendar","dateProperty":"due","mode":"month"},
        {"id":"stress-timeline","name":"Timeline","kind":"timeline","dateProperty":"starts","endDateProperty":"ends","mode":"month"},
        {"id":"stress-sheet","name":"Spreadsheet","kind":"sheet","columns":["status","owner","due","starts","ends"]}
      ],"default":"stress-list"}'::jsonb
FROM constants
ON CONFLICT (id) DO UPDATE SET
    properties = EXCLUDED.properties,
    schema = EXCLUDED.schema,
    views = EXCLUDED.views,
    lifecycle_state = 'active',
    last_modified_at = now();

-- A separate, one-item capture source makes the first application observable: its unique field is
-- absent from the stress target before the run and present after it. Applying the captured template
-- a second time must then report an idempotent no-op.
WITH constants AS (
    SELECT
        'a0000000-0000-4000-8000-000000000001'::uuid AS tenant_id,
        'a1000000-0000-4000-8000-000000000001'::uuid AS workspace_id,
        'a2000000-0000-4000-8000-000000000001'::uuid AS actor_id,
        'a6100000-0000-4000-8000-000000000002'::uuid AS source_id
)
INSERT INTO item
    (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
     purge_after, created_by, last_modified_by, created_at, last_modified_at, schema, views)
SELECT
    source_id, tenant_id, workspace_id, 'note', NULL, 901000,
    '{"title":"MVP-1 stress template source"}'::jsonb,
    'active', NULL, actor_id, actor_id, now(), now(),
    '{"properties":[
        {"key":"stress_template_marker","label":"Template marker","type":"text","options":[],"required":false}
      ],"inherit":true}'::jsonb,
    NULL
FROM constants
ON CONFLICT (id) DO UPDATE SET
    properties = EXCLUDED.properties,
    schema = EXCLUDED.schema,
    views = EXCLUDED.views,
    lifecycle_state = 'active',
    last_modified_at = now();

WITH constants AS (
    SELECT
        'a0000000-0000-4000-8000-000000000001'::uuid AS tenant_id,
        'a1000000-0000-4000-8000-000000000001'::uuid AS workspace_id,
        'a2000000-0000-4000-8000-000000000001'::uuid AS actor_id,
        'a6100000-0000-4000-8000-000000000001'::uuid AS root_id
), generated AS (
    SELECT
        ordinal,
        ('a6200000-0000-4000-8000-' || lpad(to_hex(ordinal), 12, '0'))::uuid AS id,
        CASE ordinal % 3 WHEN 0 THEN 'Done' WHEN 1 THEN 'Backlog' ELSE 'Doing' END AS status,
        (date '2026-08-01' + (ordinal % 42)) AS due
    FROM generate_series(1, 3200) AS ordinal
)
INSERT INTO item
    (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
     purge_after, created_by, last_modified_by, created_at, last_modified_at, schema, views)
SELECT
    generated.id,
    constants.tenant_id,
    constants.workspace_id,
    'note',
    constants.root_id,
    generated.ordinal * 1000,
    jsonb_strip_nulls(jsonb_build_object(
        'title', 'Stress item ' || lpad(generated.ordinal::text, 4, '0'),
        'status', generated.status,
        'owner', CASE generated.ordinal % 4 WHEN 0 THEN 'Ada' WHEN 1 THEN 'Eli' WHEN 2 THEN 'Grace' ELSE 'Lin' END,
        'due', generated.due::text,
        'starts', to_char(generated.due::timestamp + interval '9 hours', 'YYYY-MM-DD"T"HH24:MI:SS') || '+01:00[Europe/London]',
        'ends', to_char(generated.due::timestamp + interval '17 hours', 'YYYY-MM-DD"T"HH24:MI:SS') || '+01:00[Europe/London]',
        'cover', CASE WHEN generated.ordinal % 20 = 0 THEN 'http://localhost:5173/stress-cover.svg' END
    )),
    'active', NULL, constants.actor_id, constants.actor_id, now(), now(), NULL, NULL
FROM generated
CROSS JOIN constants
ON CONFLICT (id) DO UPDATE SET
    parent_id = EXCLUDED.parent_id,
    seq = EXCLUDED.seq,
    properties = EXCLUDED.properties,
    lifecycle_state = 'active',
    last_modified_at = now();

WITH constants AS (
    SELECT
        'a0000000-0000-4000-8000-000000000001'::uuid AS tenant_id,
        'a1000000-0000-4000-8000-000000000001'::uuid AS workspace_id,
        'a6100000-0000-4000-8000-000000000001'::uuid AS root_id,
        'a6100000-0000-4000-8000-000000000002'::uuid AS source_id
), generated AS (
    SELECT ('a6200000-0000-4000-8000-' || lpad(to_hex(ordinal), 12, '0'))::uuid AS id
    FROM generate_series(1, 3200) AS ordinal
), edges AS (
    SELECT root_id AS descendant_id, root_id AS ancestor_id, tenant_id, workspace_id, 0 AS depth
    FROM constants
    UNION ALL
    SELECT source_id, source_id, tenant_id, workspace_id, 0
    FROM constants
    UNION ALL
    SELECT generated.id, generated.id, constants.tenant_id, constants.workspace_id, 0
    FROM generated CROSS JOIN constants
    UNION ALL
    SELECT generated.id, constants.root_id, constants.tenant_id, constants.workspace_id, 1
    FROM generated CROSS JOIN constants
)
INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
SELECT descendant_id, ancestor_id, tenant_id, workspace_id, depth
FROM edges
ON CONFLICT (descendant_id, ancestor_id) DO UPDATE SET
    tenant_id = EXCLUDED.tenant_id,
    workspace_id = EXCLUDED.workspace_id,
    depth = EXCLUDED.depth;

SELECT count(*) AS stress_children
FROM item
WHERE parent_id = 'a6100000-0000-4000-8000-000000000001'::uuid
  AND lifecycle_state = 'active';
