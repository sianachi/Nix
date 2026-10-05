namespace Nix.Persistence.Migrations;

/// <summary>Containment metadata follows envelopes without granting Core access to CRDT writes.</summary>
public static class ItemWorkspaceTransferSecuritySql
{
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            CREATE FUNCTION public.nix_follow_item_workspace() RETURNS trigger
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
                   OR EXISTS (SELECT 1 FROM public.worker_job job
                              WHERE job.tenant_id = NEW.tenant_id AND job.workspace_id = OLD.workspace_id
                                AND job.status IN ('queued', 'running')
                                AND strpos(job.payload::text, NEW.id::text) > 0)
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
                UPDATE public.content_doc SET workspace_id = NEW.workspace_id
                    WHERE tenant_id = NEW.tenant_id AND item_id = NEW.id;
                UPDATE public.file_body SET workspace_id = NEW.workspace_id
                    WHERE tenant_id = NEW.tenant_id AND item_id = NEW.id;
                UPDATE public.file_version SET workspace_id = NEW.workspace_id
                    WHERE tenant_id = NEW.tenant_id AND item_id = NEW.id;
                UPDATE public.acl_entry SET workspace_id = NEW.workspace_id
                    WHERE tenant_id = NEW.tenant_id AND item_id = NEW.id;
                UPDATE public.public_form_link SET revoked_at = clock_timestamp()
                    WHERE tenant_id = NEW.tenant_id AND item_id = NEW.id AND revoked_at IS NULL;
                DELETE FROM public.scheduled_trigger
                    WHERE tenant_id = NEW.tenant_id AND source_item_id = NEW.id AND status = 'pending';
                RETURN NEW;
            END;
            $function$;
            REVOKE ALL ON FUNCTION public.nix_follow_item_workspace() FROM PUBLIC;
            CREATE TRIGGER item_follow_workspace
                AFTER UPDATE OF workspace_id ON public.item
                FOR EACH ROW WHEN (OLD.workspace_id IS DISTINCT FROM NEW.workspace_id)
                EXECUTE FUNCTION public.nix_follow_item_workspace();

            -- A first editor may have authorized before the move committed. Derive containment
            -- at creation too, rather than trusting the old workspace cached in that handshake.
            CREATE FUNCTION public.nix_content_doc_workspace() RETURNS trigger
            LANGUAGE plpgsql SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            BEGIN
                IF NEW.tenant_id IS DISTINCT FROM NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                   AND session_user <> 'nix_migrator' THEN
                    RAISE EXCEPTION 'invalid document tenant' USING ERRCODE = '42501';
                END IF;
                SELECT workspace_id INTO NEW.workspace_id FROM public.item
                    WHERE tenant_id = NEW.tenant_id AND id = NEW.item_id FOR SHARE;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'document item not found' USING ERRCODE = '23503';
                END IF;
                RETURN NEW;
            END;
            $function$;
            REVOKE ALL ON FUNCTION public.nix_content_doc_workspace() FROM PUBLIC;
            CREATE TRIGGER content_doc_workspace
                BEFORE INSERT OR UPDATE OF workspace_id ON public.content_doc
                FOR EACH ROW EXECUTE FUNCTION public.nix_content_doc_workspace();

            -- Deferred because a transfer updates all descendants before replacing the root
            -- parent. Also catches an insert that waited on a moved parent with stale metadata.
            CREATE FUNCTION public.nix_item_workspace_parent() RETURNS trigger
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
                IF FOUND AND EXISTS (SELECT 1 FROM public.item child
                    WHERE child.tenant_id = current_item.tenant_id AND child.parent_id = current_item.id
                      AND child.workspace_id <> current_item.workspace_id) THEN
                    RAISE EXCEPTION 'child belongs to another workspace'
                        USING ERRCODE = '23514', CONSTRAINT = 'item_workspace_parent';
                END IF;
                RETURN NULL;
            END;
            $function$;
            REVOKE ALL ON FUNCTION public.nix_item_workspace_parent() FROM PUBLIC;
            CREATE CONSTRAINT TRIGGER item_workspace_parent
                AFTER INSERT OR UPDATE OF workspace_id, parent_id ON public.item
                DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
                EXECUTE FUNCTION public.nix_item_workspace_parent();
            """);
    }

    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP TRIGGER IF EXISTS item_workspace_parent ON public.item;
            DROP FUNCTION IF EXISTS public.nix_item_workspace_parent();
            DROP TRIGGER IF EXISTS content_doc_workspace ON public.content_doc;
            DROP FUNCTION IF EXISTS public.nix_content_doc_workspace();
            DROP TRIGGER IF EXISTS item_follow_workspace ON public.item;
            DROP FUNCTION IF EXISTS public.nix_follow_item_workspace();
            """);
    }
}
