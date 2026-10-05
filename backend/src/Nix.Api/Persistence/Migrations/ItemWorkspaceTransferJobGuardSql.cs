namespace Nix.Persistence.Migrations;

/// <summary>Bounds transfer job inspection, search events and deferred containment checks.</summary>
public static class ItemWorkspaceTransferJobGuardSql
{
    /// <summary>The trigger query, also used to capture its realistic database plan.</summary>
    public const string ActiveJobReferences = """
        WITH moved AS MATERIALIZED (
            SELECT candidate.id, candidate.tenant_id, previous.workspace_id
            FROM new_items candidate JOIN old_items previous ON candidate.id = previous.id AND candidate.tenant_id = previous.tenant_id
            WHERE candidate.workspace_id IS DISTINCT FROM previous.workspace_id
        ), job_references AS MATERIALIZED (
            SELECT job.tenant_id, job.workspace_id, reference[1]::uuid AS item_id
            FROM public.worker_job job
            CROSS JOIN LATERAL regexp_matches(job.payload::text,
                '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 'gi') AS reference
            WHERE job.status IN ('queued', 'running')
              AND EXISTS (SELECT 1 FROM moved WHERE moved.tenant_id = job.tenant_id
                  AND moved.workspace_id = job.workspace_id)
        )
        SELECT 1 FROM moved JOIN job_references reference
            ON reference.tenant_id = moved.tenant_id AND reference.workspace_id = moved.workspace_id
                AND reference.item_id = moved.id
        """;

    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit(FollowWorkspace(inspectJobs: false));
        emit(SearchQueue(fanOutWorkspaceChanges: false));
        emit(ParentConsistency(checkInsertedChildren: false));
        emit($$"""
            CREATE FUNCTION public.nix_guard_workspace_transfer_jobs() RETURNS trigger
            LANGUAGE plpgsql SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM new_items candidate JOIN old_items previous ON candidate.id = previous.id AND candidate.tenant_id = previous.tenant_id
                    WHERE candidate.workspace_id IS DISTINCT FROM previous.workspace_id) THEN
                    RETURN NULL;
                END IF;
                IF EXISTS (SELECT 1 FROM new_items candidate JOIN old_items previous ON candidate.id = previous.id AND candidate.tenant_id = previous.tenant_id
                    WHERE candidate.workspace_id IS DISTINCT FROM previous.workspace_id
                      AND (candidate.tenant_id IS DISTINCT FROM previous.tenant_id
                           OR candidate.tenant_id IS DISTINCT FROM NULLIF(current_setting('nix.tenant_id', true), '')::uuid)) THEN
                    RAISE EXCEPTION 'invalid workspace transfer tenant' USING ERRCODE = '42501';
                END IF;
                IF EXISTS (
                    {{ActiveJobReferences}}
                ) THEN
                    RAISE EXCEPTION 'workspace-bound operation prevents transfer'
                        USING ERRCODE = '23514', CONSTRAINT = 'item_workspace_transfer_allowed';
                END IF;
                RETURN NULL;
            END;
            $function$;
            REVOKE ALL ON FUNCTION public.nix_guard_workspace_transfer_jobs() FROM PUBLIC;
            CREATE TRIGGER item_workspace_transfer_jobs
                AFTER UPDATE ON public.item
                REFERENCING OLD TABLE AS old_items NEW TABLE AS new_items
                FOR EACH STATEMENT EXECUTE FUNCTION public.nix_guard_workspace_transfer_jobs();
            """);
    }

    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP TRIGGER IF EXISTS item_workspace_transfer_jobs ON public.item;
            DROP FUNCTION IF EXISTS public.nix_guard_workspace_transfer_jobs();
            """);
        emit(FollowWorkspace(inspectJobs: true));
        emit(SearchQueue(fanOutWorkspaceChanges: true));
        emit(ParentConsistency(checkInsertedChildren: true));
    }

    // Restoring the historical row guard is deliberate: rolling back this migration must
    // preserve active-job refusals while the original transfer migration remains installed.
    private static string FollowWorkspace(bool inspectJobs) => $$"""
        CREATE OR REPLACE FUNCTION public.nix_follow_item_workspace() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog, public, pg_temp
        AS $function$
        BEGIN
            IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
               OR NEW.tenant_id IS DISTINCT FROM NULLIF(current_setting('nix.tenant_id', true), '')::uuid THEN
                RAISE EXCEPTION 'invalid workspace transfer tenant' USING ERRCODE = '42501';
            END IF;
            IF EXISTS (SELECT 1 FROM public.file_upload upload
                       WHERE upload.tenant_id = NEW.tenant_id
                         AND upload.status = 'pending_upload' AND upload.expires_at > clock_timestamp()
                         AND (upload.parent_id = NEW.id OR upload.target_item_id = NEW.id))
               {{(inspectJobs ? """
               OR EXISTS (SELECT 1 FROM public.worker_job job
                          WHERE job.tenant_id = NEW.tenant_id AND job.workspace_id = OLD.workspace_id
                            AND job.status IN ('queued', 'running')
                            AND strpos(job.payload::text, NEW.id::text) > 0)
               """ : "")}}
               OR EXISTS (SELECT 1 FROM public.template_operation operation
                          WHERE operation.tenant_id = NEW.tenant_id AND operation.source_item_id = NEW.id
                            AND operation.state = 'provisioning')
               OR EXISTS (SELECT 1 FROM public.template_application application
                          WHERE application.tenant_id = NEW.tenant_id AND application.state = 'provisioning'
                            AND (application.target_item_id = NEW.id OR application.parent_item_id = NEW.id))
               OR EXISTS (SELECT 1 FROM public.document_import import_row
                          WHERE import_row.tenant_id = NEW.tenant_id AND import_row.parent_id = NEW.id
                            AND import_row.status NOT IN ('completed', 'failed', 'cancelled')
                            AND import_row.expires_at > clock_timestamp())
               OR EXISTS (SELECT 1 FROM public.automation_rule rule
                          WHERE rule.tenant_id = NEW.tenant_id AND rule.scope_item_id = NEW.id AND rule.enabled) THEN
                RAISE EXCEPTION 'workspace-bound operation prevents transfer'
                    USING ERRCODE = '23514', CONSTRAINT = 'item_workspace_transfer_allowed';
            END IF;
            UPDATE public.content_doc SET workspace_id = NEW.workspace_id WHERE tenant_id = NEW.tenant_id AND item_id = NEW.id;
            UPDATE public.file_body SET workspace_id = NEW.workspace_id WHERE tenant_id = NEW.tenant_id AND item_id = NEW.id;
            UPDATE public.file_version SET workspace_id = NEW.workspace_id WHERE tenant_id = NEW.tenant_id AND item_id = NEW.id;
            UPDATE public.acl_entry SET workspace_id = NEW.workspace_id WHERE tenant_id = NEW.tenant_id AND item_id = NEW.id;
            UPDATE public.public_form_link SET revoked_at = clock_timestamp()
                WHERE tenant_id = NEW.tenant_id AND item_id = NEW.id AND revoked_at IS NULL;
            DELETE FROM public.scheduled_trigger WHERE tenant_id = NEW.tenant_id AND source_item_id = NEW.id AND status = 'pending';
            RETURN NEW;
        END;
        $function$;
        REVOKE ALL ON FUNCTION public.nix_follow_item_workspace() FROM PUBLIC;
        """;
    private static string SearchQueue(bool fanOutWorkspaceChanges) => $$"""
        CREATE OR REPLACE FUNCTION public.nix_queue_item_search_event()
        RETURNS trigger
        LANGUAGE plpgsql
        VOLATILE
        SECURITY DEFINER
        SET search_path = pg_catalog, public, pg_temp
        AS $function$
        DECLARE
            changed_id uuid;
            changed_tenant uuid;
            changed_workspace uuid;
            fan_out boolean;
        BEGIN
            IF TG_OP = 'DELETE' THEN
                INSERT INTO public.worker_outbox_event (
                    event_id, tenant_id, workspace_id, item_id, kind, payload, available_at, attempts)
                VALUES (
                    gen_random_uuid(), OLD.tenant_id, OLD.workspace_id, OLD.id,
                    'item.deleted', '{}'::jsonb, clock_timestamp(), 0);
                RETURN OLD;
            END IF;

            changed_id := NEW.id;
            changed_tenant := NEW.tenant_id;
            changed_workspace := NEW.workspace_id;
            IF TG_OP = 'INSERT' THEN
                -- Every newly inserted descendant receives its own deferred event. Fan-out here
                -- would duplicate every child during atomic subtree publication. Avoid a lookup
                -- as well: large imports can insert tens of thousands of rows in one transaction.
                INSERT INTO public.worker_outbox_event (
                    event_id, tenant_id, workspace_id, item_id, kind, payload, available_at, attempts)
                VALUES (
                    gen_random_uuid(), changed_tenant, changed_workspace, changed_id,
                    'item.changed', '{}'::jsonb, clock_timestamp(), 0);
                RETURN NEW;
            END IF;

            fan_out := OLD.parent_id IS DISTINCT FROM NEW.parent_id
                {{(fanOutWorkspaceChanges ? "OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id" : "")}}
                OR OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state
                OR OLD.template_id IS DISTINCT FROM NEW.template_id;

            -- A transfer updates every descendant envelope; enqueue each once. Other
            -- structural changes still invalidate inherited state throughout the subtree.
            IF NOT fan_out THEN
                INSERT INTO public.worker_outbox_event (
                    event_id, tenant_id, workspace_id, item_id, kind, payload, available_at, attempts)
                VALUES (gen_random_uuid(), changed_tenant, changed_workspace, changed_id,
                        'item.changed', '{}'::jsonb, clock_timestamp(), 0);
                RETURN NEW;
            END IF;

            INSERT INTO public.worker_outbox_event (
                event_id, tenant_id, workspace_id, item_id, kind, payload, available_at, attempts)
            SELECT gen_random_uuid(), indexed.tenant_id, indexed.workspace_id, indexed.id,
                   'item.changed', '{}'::jsonb, clock_timestamp(), 0
              FROM public.item indexed
             WHERE indexed.tenant_id = changed_tenant
               AND (
                    indexed.id = changed_id
                    OR (fan_out AND EXISTS (
                        SELECT 1
                          FROM public.item_closure edge
                         WHERE edge.tenant_id = changed_tenant
                           AND edge.ancestor_id = changed_id
                           AND edge.descendant_id = indexed.id
                           AND edge.depth > 0)))
             ORDER BY indexed.id;
            RETURN NEW;
        END
        $function$;
        REVOKE ALL ON FUNCTION public.nix_queue_item_search_event() FROM PUBLIC;
        """;

    private static string ParentConsistency(bool checkInsertedChildren) => $$"""
        CREATE OR REPLACE FUNCTION public.nix_item_workspace_parent() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp
        AS $function$
        DECLARE current_item public.item%ROWTYPE;
        BEGIN
            SELECT * INTO current_item FROM public.item
                WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
            IF FOUND AND current_item.parent_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM public.item parent
                WHERE parent.tenant_id = current_item.tenant_id AND parent.id = current_item.parent_id
                  AND parent.workspace_id = current_item.workspace_id) THEN
                RAISE EXCEPTION 'parent belongs to another workspace'
                    USING ERRCODE = '23514', CONSTRAINT = 'item_workspace_parent';
            END IF;
            {{(checkInsertedChildren ? """
            IF FOUND AND EXISTS (SELECT 1 FROM public.item child
                WHERE child.tenant_id = current_item.tenant_id AND child.parent_id = current_item.id
                  AND child.workspace_id <> current_item.workspace_id) THEN
                RAISE EXCEPTION 'child belongs to another workspace'
                    USING ERRCODE = '23514', CONSTRAINT = 'item_workspace_parent';
            END IF;
            """ : """
            -- Inserted children validate their own parent. Only a workspace-changing parent
            -- can leave existing children behind, and its FK prevents delete/reinsert gaps.
            IF TG_OP = 'UPDATE' THEN
                IF FOUND AND OLD.workspace_id IS DISTINCT FROM NEW.workspace_id AND EXISTS (
                    SELECT 1 FROM public.item child
                    WHERE child.tenant_id = current_item.tenant_id AND child.parent_id = current_item.id
                      AND child.workspace_id <> current_item.workspace_id) THEN
                    RAISE EXCEPTION 'child belongs to another workspace'
                        USING ERRCODE = '23514', CONSTRAINT = 'item_workspace_parent';
                END IF;
            END IF;
            """)}}

            RETURN NULL;
        END;
        $function$;
        REVOKE ALL ON FUNCTION public.nix_item_workspace_parent() FROM PUBLIC;
        """;
}
