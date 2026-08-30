namespace Nix.Persistence.Sql.Statements;

/// <summary>Permission-filtered workspace reads and invariant-preserving administration writes.</summary>
public static class WorkspaceAdministrationSql
{
    /// <summary>
    /// Lists reachable workspaces and computes capabilities in the database. The membership
    /// predicate is part of the query, so callers never receive a tenant-wide result to filter.
    /// </summary>
    public const string List = """
        WITH caller AS (
            SELECT p.kind = 'user' AND p.status = 'active' AS active_human,
                   EXISTS (
                       SELECT 1 FROM tenant_role tr
                       WHERE tr.tenant_id = @tenant_id AND tr.role = 'admin'
                         AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                           OR (tr.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = tr.tenant_id
                                 AND gm.group_id = tr.subject_id
                                 AND gm.principal_id = @principal_id)))
                   ) AS tenant_admin
            FROM principal p
            WHERE p.tenant_id = @tenant_id AND p.principal_id = @principal_id
        ), candidates AS MATERIALIZED (
            SELECT w.workspace_id, w.name, w.version_retention_days,
                   w.storage_quota_bytes, w.created_at, w.personal_owner_principal_id
            FROM workspace w
            CROSS JOIN caller c
            WHERE w.tenant_id = @tenant_id
              AND (c.tenant_admin OR EXISTS (
                  SELECT 1 FROM workspace_member wm
                  WHERE wm.tenant_id = w.tenant_id AND wm.workspace_id = w.workspace_id
                    AND (wm.subject_type = 'principal' AND wm.subject_id = @principal_id
                      OR wm.subject_type = 'group' AND EXISTS (
                          SELECT 1 FROM group_membership gm
                          WHERE gm.tenant_id = wm.tenant_id AND gm.group_id = wm.subject_id
                            AND gm.principal_id = @principal_id))))
              AND (@after_created_at IS NULL
                   OR (w.created_at, w.workspace_id) < (@after_created_at, @after_id))
            ORDER BY w.created_at DESC, w.workspace_id DESC
            LIMIT @limit
        ), reachable AS (
            SELECT candidate.*,
                   COALESCE(held.role_rank, -1) AS role_rank,
                   COALESCE(held.direct_member, false) AS direct_member,
                   COALESCE(held.direct_owner, false) AS direct_owner
            FROM candidates candidate
            LEFT JOIN LATERAL (
                SELECT MAX(CASE wm.role
                         WHEN 'owner' THEN 3 WHEN 'editor' THEN 2
                         WHEN 'commenter' THEN 1 WHEN 'viewer' THEN 0 END) AS role_rank,
                       bool_or(wm.subject_type = 'principal' AND wm.subject_id = @principal_id)
                           AS direct_member,
                       bool_or(wm.subject_type = 'principal' AND wm.subject_id = @principal_id
                           AND wm.role = 'owner') AS direct_owner
                FROM workspace_member wm
                WHERE wm.tenant_id = @tenant_id AND wm.workspace_id = candidate.workspace_id
                  AND (wm.subject_type = 'principal' AND wm.subject_id = @principal_id
                    OR wm.subject_type = 'group' AND EXISTS (
                        SELECT 1 FROM group_membership gm
                        WHERE gm.tenant_id = wm.tenant_id AND gm.group_id = wm.subject_id
                          AND gm.principal_id = @principal_id))
            ) held ON true
        )
        SELECT r.workspace_id, r.name, r.version_retention_days, r.storage_quota_bytes,
               r.created_at, r.personal_owner_principal_id,
               (c.tenant_admin OR r.role_rank = 3) AS can_rename,
               (c.tenant_admin OR r.role_rank = 3) AS can_manage_members,
               (pending.invitation_id IS NULL
                 AND r.direct_member AND r.personal_owner_principal_id IS DISTINCT FROM @principal_id
                 AND NOT (r.direct_owner AND r.personal_owner_principal_id IS NULL AND
                    (SELECT count(*) FROM workspace_member owners
                     JOIN principal owner_principal
                       ON owner_principal.tenant_id = owners.tenant_id
                      AND owner_principal.principal_id = owners.subject_id
                     WHERE owners.tenant_id = @tenant_id
                       AND owners.workspace_id = r.workspace_id
                       AND owners.subject_type = 'principal' AND owners.role = 'owner'
                       AND owner_principal.kind = 'user' AND owner_principal.status = 'active') = 1)
               ) AS can_leave,
               pending.invitation_id
        FROM reachable r CROSS JOIN caller c
        LEFT JOIN LATERAL (
            SELECT invitation.invitation_id
            FROM workspace_invitation invitation
            WHERE invitation.tenant_id = @tenant_id
              AND invitation.workspace_id = r.workspace_id
              AND invitation.target_principal_id = @principal_id
              AND invitation.status = 'pending'
            LIMIT 1
        ) pending ON true
        ORDER BY r.created_at DESC, r.workspace_id DESC
        """;

    /// <summary>Detail is the same permission-filtered relation as list, narrowed by identifier.</summary>
    public const string Detail = """
        WITH caller AS (
            SELECT EXISTS (
                SELECT 1 FROM tenant_role tr
                WHERE tr.tenant_id = @tenant_id AND tr.role = 'admin'
                  AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                    OR (tr.subject_type = 'group' AND EXISTS (
                        SELECT 1 FROM group_membership gm
                        WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                          AND gm.principal_id = @principal_id)))
            ) AS tenant_admin
        ), held AS (
            SELECT COALESCE(MAX(CASE wm.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2
                    WHEN 'commenter' THEN 1 WHEN 'viewer' THEN 0 END), -1) role_rank,
                   COALESCE(bool_or(wm.subject_type = 'principal' AND wm.subject_id = @principal_id), false) direct_member,
                   COALESCE(bool_or(wm.subject_type = 'principal' AND wm.subject_id = @principal_id
                     AND wm.role = 'owner'), false) direct_owner
            FROM workspace_member wm
            WHERE wm.tenant_id = @tenant_id AND wm.workspace_id = @workspace_id
              AND (wm.subject_type = 'principal' AND wm.subject_id = @principal_id
                OR wm.subject_type = 'group' AND EXISTS (
                    SELECT 1 FROM group_membership gm
                    WHERE gm.tenant_id = wm.tenant_id AND gm.group_id = wm.subject_id
                      AND gm.principal_id = @principal_id))
        )
        SELECT w.workspace_id, w.name, w.version_retention_days, w.storage_quota_bytes,
               w.created_at, w.personal_owner_principal_id,
               (c.tenant_admin OR h.role_rank = 3), (c.tenant_admin OR h.role_rank = 3),
               (pending.invitation_id IS NULL
                 AND h.direct_member AND w.personal_owner_principal_id IS DISTINCT FROM @principal_id
                 AND NOT (h.direct_owner AND w.personal_owner_principal_id IS NULL AND
                    (SELECT count(*) FROM workspace_member owners
                     JOIN principal p ON p.tenant_id = owners.tenant_id
                       AND p.principal_id = owners.subject_id
                     WHERE owners.tenant_id = @tenant_id AND owners.workspace_id = w.workspace_id
                       AND owners.subject_type = 'principal' AND owners.role = 'owner'
                       AND p.kind = 'user' AND p.status = 'active') = 1)),
               pending.invitation_id
        FROM workspace w CROSS JOIN caller c CROSS JOIN held h
        LEFT JOIN LATERAL (
            SELECT invitation.invitation_id
            FROM workspace_invitation invitation
            WHERE invitation.tenant_id = @tenant_id
              AND invitation.workspace_id = w.workspace_id
              AND invitation.target_principal_id = @principal_id
              AND invitation.status = 'pending'
            LIMIT 1
        ) pending ON true
        WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
          AND (c.tenant_admin OR h.role_rank >= 0)
        """;

    /// <summary>Creates a shared workspace only for the active human caller.</summary>
    public const string Create = """
        WITH eligible AS (
            SELECT 1 FROM principal
            WHERE tenant_id = @tenant_id AND principal_id = @principal_id
              AND kind = 'user' AND status = 'active'
        ), created AS (
            INSERT INTO workspace (
                workspace_id, tenant_id, name, version_retention_days,
                coalesce_window_min, storage_quota_bytes, created_at,
                personal_owner_principal_id)
            SELECT @workspace_id, @tenant_id, @name, 90, 10, 10737418240, @now, NULL
            FROM eligible
            RETURNING workspace_id
        ), membership AS (
            INSERT INTO workspace_member (
                workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            SELECT workspace_id, 'principal', @principal_id, @tenant_id, 'owner', @principal_id, @now
            FROM created
        )
        SELECT EXISTS (SELECT 1 FROM created)
        """;

    /// <summary>Renames only when the caller is an owner or tenant administrator.</summary>
    public const string Rename = """
        UPDATE workspace w SET name = @name
        WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
          AND (EXISTS (SELECT 1 FROM workspace_member wm
                       WHERE wm.tenant_id = w.tenant_id AND wm.workspace_id = w.workspace_id
                         AND wm.role = 'owner'
                         AND ((wm.subject_type = 'principal' AND wm.subject_id = @principal_id)
                           OR (wm.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = wm.tenant_id AND gm.group_id = wm.subject_id
                                 AND gm.principal_id = @principal_id))))
            OR EXISTS (SELECT 1 FROM tenant_role tr
                       WHERE tr.tenant_id = w.tenant_id AND tr.role = 'admin'
                         AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                           OR (tr.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                 AND gm.principal_id = @principal_id)))))
        RETURNING workspace_id
        """;

    /// <summary>Lists principal and group grants; only direct principal grants are mutable.</summary>
    public const string Members = """
        WITH authorized AS MATERIALIZED (
            SELECT w.personal_owner_principal_id,
                   EXISTS (SELECT 1 FROM workspace_member caller
                           WHERE caller.tenant_id = w.tenant_id AND caller.workspace_id = w.workspace_id
                             AND caller.role = 'owner'
                             AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                               OR (caller.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                     AND gm.principal_id = @principal_id))))
                     OR EXISTS (SELECT 1 FROM tenant_role tr WHERE tr.tenant_id = w.tenant_id
                                  AND tr.role = 'admin'
                                  AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                                    OR (tr.subject_type = 'group' AND EXISTS (
                                        SELECT 1 FROM group_membership gm
                                        WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                          AND gm.principal_id = @principal_id)))) AS can_manage
            FROM workspace w
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND (EXISTS (SELECT 1 FROM workspace_member caller
                           WHERE caller.tenant_id = w.tenant_id AND caller.workspace_id = w.workspace_id
                             AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                               OR (caller.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                     AND gm.principal_id = @principal_id))))
                OR EXISTS (SELECT 1 FROM tenant_role tr WHERE tr.tenant_id = w.tenant_id
                             AND tr.role = 'admin'
                             AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                               OR (tr.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                     AND gm.principal_id = @principal_id)))))
        ), owner_state AS MATERIALIZED (
            SELECT count(*) AS active_human_owner_count
            FROM workspace_member owner
            JOIN principal owner_principal ON owner_principal.tenant_id = owner.tenant_id
              AND owner_principal.principal_id = owner.subject_id
            WHERE owner.tenant_id = @tenant_id AND owner.workspace_id = @workspace_id
              AND owner.subject_type = 'principal' AND owner.role = 'owner'
              AND owner_principal.kind = 'user' AND owner_principal.status = 'active'
        )
        SELECT wm.subject_type, wm.subject_id, COALESCE(p.display_name, pg.name), p.email,
               wm.role, wm.granted_at,
               wm.subject_type = 'principal' AND authorized.can_manage
                 AND NOT state.protected_owner AND NOT state.last_owner
                 AND NOT state.provisional AS can_change_role,
               wm.subject_type = 'principal' AND authorized.can_manage
                 AND NOT state.protected_owner AND NOT state.last_owner
                 AND NOT state.provisional AS can_remove,
               CASE
                 WHEN wm.subject_type <> 'principal' OR NOT authorized.can_manage
                   OR state.protected_owner OR state.last_owner OR state.provisional
                   THEN ARRAY[]::text[]
                 WHEN authorized.personal_owner_principal_id IS NOT NULL THEN ARRAY['editor','viewer']::text[]
                 ELSE ARRAY['owner','editor','viewer']::text[]
               END AS assignable_roles
        FROM workspace_member wm
        CROSS JOIN authorized
        CROSS JOIN owner_state
        LEFT JOIN LATERAL (
            SELECT candidate.display_name, candidate.email, candidate.kind, candidate.status
            FROM principal candidate
            WHERE wm.subject_type = 'principal' AND candidate.tenant_id = @tenant_id
              AND candidate.principal_id = wm.subject_id
            LIMIT 1
        ) p ON true
        LEFT JOIN LATERAL (
            SELECT candidate.name
            FROM principal_group candidate
            WHERE wm.subject_type = 'group' AND candidate.tenant_id = @tenant_id
              AND candidate.group_id = wm.subject_id
            LIMIT 1
        ) pg ON true
        CROSS JOIN LATERAL (
            SELECT wm.subject_type = 'principal'
                     AND COALESCE(authorized.personal_owner_principal_id = wm.subject_id, false)
                     AS protected_owner,
                   wm.subject_type = 'principal' AND wm.role = 'owner'
                     AND authorized.personal_owner_principal_id IS NULL
                     AND p.kind = 'user' AND p.status = 'active'
                     AND owner_state.active_human_owner_count = 1 AS last_owner,
                   wm.subject_type = 'principal' AND EXISTS (
                       SELECT 1 FROM workspace_invitation invitation
                       WHERE invitation.tenant_id = wm.tenant_id
                         AND invitation.workspace_id = wm.workspace_id
                         AND invitation.target_principal_id = wm.subject_id
                         AND invitation.status = 'pending') AS provisional
        ) state
        WHERE wm.tenant_id = @tenant_id AND wm.workspace_id = @workspace_id
          AND (@target_principal_id IS NULL
               OR (wm.subject_type = 'principal' AND wm.subject_id = @target_principal_id))
          AND (@after_granted_at IS NULL
               OR wm.granted_at < @after_granted_at
               OR (wm.granted_at = @after_granted_at
                   AND (wm.subject_type, wm.subject_id) > (@after_subject_type, @after_id)))
        ORDER BY wm.granted_at DESC, wm.subject_type, wm.subject_id
        LIMIT @limit
        """;

    /// <summary>Lists active humans without effective access for an authorized invite dropdown.</summary>
    public const string Invitees = """
        WITH authorized AS MATERIALIZED (
            SELECT 1
            FROM workspace w
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND (EXISTS (SELECT 1 FROM workspace_member caller
                           WHERE caller.tenant_id = w.tenant_id AND caller.workspace_id = w.workspace_id
                             AND caller.role = 'owner'
                             AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                               OR (caller.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                     AND gm.principal_id = @principal_id))))
                OR EXISTS (SELECT 1 FROM tenant_role tr
                           WHERE tr.tenant_id = w.tenant_id AND tr.role = 'admin'
                             AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                               OR (tr.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                     AND gm.principal_id = @principal_id)))))
        )
        SELECT candidate.principal_id, candidate.display_name, candidate.email
        FROM principal candidate
        CROSS JOIN authorized
        WHERE candidate.tenant_id = @tenant_id
          AND candidate.kind = 'user' AND candidate.status = 'active'
          AND candidate.email_verified AND candidate.email_normalized IS NOT NULL
          AND candidate.email IS NOT NULL
          AND candidate.principal_id <> @principal_id
          AND (@after_id IS NULL OR candidate.principal_id > @after_id)
          AND NOT EXISTS (
              SELECT 1 FROM workspace_member member
              WHERE member.tenant_id = @tenant_id AND member.workspace_id = @workspace_id
                AND ((member.subject_type = 'principal' AND member.subject_id = candidate.principal_id)
                  OR (member.subject_type = 'group' AND EXISTS (
                      SELECT 1 FROM group_membership membership
                      WHERE membership.tenant_id = member.tenant_id
                        AND membership.group_id = member.subject_id
                        AND membership.principal_id = candidate.principal_id))))
        ORDER BY candidate.principal_id
        LIMIT @limit
        """;

    /// <summary>Lists invitation history for workspace owners and tenant administrators.</summary>
    public const string Invitations = """
        SELECT i.invitation_id, i.email_normalized, i.target_principal_id,
               i.role, i.status, i.invited_by_principal_id,
               i.invited_at, i.accepted_at, i.accepted_by_principal_id, i.revoked_at
        FROM workspace_invitation i
        WHERE i.tenant_id = @tenant_id AND i.workspace_id = @workspace_id
          AND (EXISTS (SELECT 1 FROM workspace_member caller
                       WHERE caller.tenant_id = i.tenant_id AND caller.workspace_id = i.workspace_id
                         AND caller.role = 'owner'
                         AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                           OR (caller.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                 AND gm.principal_id = @principal_id))))
            OR EXISTS (SELECT 1 FROM tenant_role tr WHERE tr.tenant_id = i.tenant_id
                         AND tr.role = 'admin'
                         AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                           OR (tr.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                 AND gm.principal_id = @principal_id)))))
          AND (@after_invited_at IS NULL OR (i.invited_at, i.invitation_id) < (@after_invited_at, @after_id))
        ORDER BY i.invited_at DESC, i.invitation_id DESC
        LIMIT @limit
        """;

    /// <summary>Reads one invitation through the same owner-or-administrator authorization.</summary>
    public const string InvitationById = """
        SELECT i.invitation_id, i.email_normalized, i.target_principal_id,
               i.role, i.status, i.invited_by_principal_id,
               i.invited_at, i.accepted_at, i.accepted_by_principal_id, i.revoked_at
        FROM workspace_invitation i
        WHERE i.tenant_id = @tenant_id AND i.workspace_id = @workspace_id
          AND i.invitation_id = @invitation_id
          AND (EXISTS (SELECT 1 FROM workspace_member caller
                       WHERE caller.tenant_id = i.tenant_id AND caller.workspace_id = i.workspace_id
                         AND caller.role = 'owner'
                         AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                           OR (caller.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                 AND gm.principal_id = @principal_id))))
            OR EXISTS (SELECT 1 FROM tenant_role tr WHERE tr.tenant_id = i.tenant_id
                         AND tr.role = 'admin'
                         AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                           OR (tr.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                 AND gm.principal_id = @principal_id)))))
        """;

    /// <summary>Creates pending invitation history and grants its target provisional access.</summary>
    public const string CreateInvitation = """
        WITH locked_workspace AS MATERIALIZED (
            SELECT w.personal_owner_principal_id
            FROM workspace w
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND (EXISTS (SELECT 1 FROM workspace_member caller
                           WHERE caller.tenant_id = w.tenant_id AND caller.workspace_id = w.workspace_id
                             AND caller.role = 'owner'
                             AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                               OR (caller.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                     AND gm.principal_id = @principal_id))))
                OR EXISTS (SELECT 1 FROM tenant_role tr WHERE tr.tenant_id = w.tenant_id
                             AND tr.role = 'admin'
                             AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                               OR (tr.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                     AND gm.principal_id = @principal_id)))))
            FOR UPDATE
        ), target AS MATERIALIZED (
            SELECT person.principal_id, person.email_normalized
            FROM principal person
            CROSS JOIN locked_workspace workspace
            WHERE person.tenant_id = @tenant_id
              AND person.principal_id = @target_principal_id
              AND person.principal_id <> @principal_id
              AND person.kind = 'user' AND person.status = 'active'
              AND person.email_verified AND person.email_normalized IS NOT NULL
              AND person.principal_id IS DISTINCT FROM workspace.personal_owner_principal_id
              AND (workspace.personal_owner_principal_id IS NULL OR @role <> 'owner')
              AND NOT EXISTS (
                  SELECT 1 FROM workspace_member member
                  WHERE member.tenant_id = @tenant_id AND member.workspace_id = @workspace_id
                    AND ((member.subject_type = 'principal' AND member.subject_id = person.principal_id)
                      OR (member.subject_type = 'group' AND EXISTS (
                          SELECT 1 FROM group_membership membership
                          WHERE membership.tenant_id = member.tenant_id
                            AND membership.group_id = member.subject_id
                            AND membership.principal_id = person.principal_id))))
        ), inserted AS (
            INSERT INTO workspace_invitation (
                invitation_id, tenant_id, workspace_id, email_normalized, target_principal_id, role,
                invited_by_principal_id, status, invited_at, accepted_at,
                accepted_by_principal_id, revoked_at)
            SELECT @invitation_id, @tenant_id, @workspace_id, target.email_normalized,
                   target.principal_id, @role, @principal_id, 'pending', @now, NULL, NULL, NULL
            FROM target
            ON CONFLICT (tenant_id, workspace_id, email_normalized) WHERE status = 'pending'
            DO UPDATE SET target_principal_id = EXCLUDED.target_principal_id
            WHERE workspace_invitation.role = EXCLUDED.role
              AND workspace_invitation.target_principal_id = EXCLUDED.target_principal_id
            RETURNING invitation_id, email_normalized, target_principal_id, role, status,
                      invited_by_principal_id, invited_at, accepted_at,
                      accepted_by_principal_id, revoked_at
        ), membership AS (
            INSERT INTO workspace_member (
                workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            SELECT @workspace_id, 'principal', invitation.target_principal_id, @tenant_id,
                   CASE invitation.role WHEN 'owner' THEN 'editor' ELSE invitation.role END,
                   @principal_id, @now
            FROM inserted invitation
            ON CONFLICT (workspace_id, subject_type, subject_id) DO NOTHING
        )
        SELECT 'ok', invitation_id, email_normalized, target_principal_id,
               role, status, invited_by_principal_id,
               invited_at, accepted_at, accepted_by_principal_id, revoked_at
        FROM inserted
        UNION ALL
        SELECT CASE WHEN EXISTS (SELECT 1 FROM locked_workspace) THEN 'conflict' ELSE 'not_found' END,
               NULL::uuid, NULL::text, NULL::uuid, NULL::text, NULL::text, NULL::uuid,
               NULL::timestamptz, NULL::timestamptz, NULL::uuid, NULL::timestamptz
        WHERE NOT EXISTS (SELECT 1 FROM inserted)
        """;

    /// <summary>Revokes a pending invitation and removes the direct provisional grant.</summary>
    public const string RevokeInvitation = """
        WITH target AS MATERIALIZED (
            SELECT invitation.target_principal_id
            FROM workspace_invitation invitation
            WHERE invitation.tenant_id = @tenant_id AND invitation.workspace_id = @workspace_id
              AND invitation.invitation_id = @invitation_id AND invitation.status = 'pending'
              AND invitation.target_principal_id IS NOT NULL
              AND (EXISTS (SELECT 1 FROM workspace_member caller
                       WHERE caller.tenant_id = invitation.tenant_id AND caller.workspace_id = invitation.workspace_id
                         AND caller.role = 'owner'
                         AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                           OR (caller.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                 AND gm.principal_id = @principal_id))))
            OR EXISTS (SELECT 1 FROM tenant_role tr WHERE tr.tenant_id = invitation.tenant_id
                         AND tr.role = 'admin'
                         AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                           OR (tr.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                 AND gm.principal_id = @principal_id)))))
            FOR UPDATE
        ), membership AS (
            DELETE FROM workspace_member member
            USING target
            WHERE member.tenant_id = @tenant_id AND member.workspace_id = @workspace_id
              AND member.subject_type = 'principal'
              AND member.subject_id = target.target_principal_id
        )
        UPDATE workspace_invitation invitation
        SET status = 'revoked', revoked_at = @now
        FROM target
        WHERE invitation.tenant_id = @tenant_id AND invitation.workspace_id = @workspace_id
          AND invitation.invitation_id = @invitation_id AND invitation.status = 'pending'
        """;

    /// <summary>Accepts the caller's pending invitation and applies an offered owner role.</summary>
    public const string AcceptInvitation = """
        WITH accepted AS (
            UPDATE workspace_invitation invitation
            SET status = 'accepted', accepted_at = @now, accepted_by_principal_id = @principal_id
            WHERE invitation.tenant_id = @tenant_id AND invitation.workspace_id = @workspace_id
              AND invitation.invitation_id = @invitation_id AND invitation.status = 'pending'
              AND invitation.target_principal_id = @principal_id
            RETURNING invitation.invitation_id, invitation.role
        ), membership AS (
            INSERT INTO workspace_member (
                workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            SELECT @workspace_id, 'principal', @principal_id, @tenant_id,
                   accepted.role, @principal_id, @now
            FROM accepted
            ON CONFLICT (workspace_id, subject_type, subject_id)
            DO UPDATE SET role = EXCLUDED.role, granted_at = EXCLUDED.granted_at
            RETURNING workspace_id
        )
        SELECT invitation_id FROM accepted CROSS JOIN membership
        """;

    /// <summary>Declines the caller's pending invitation and removes provisional direct access.</summary>
    public const string DeclineInvitation = """
        WITH declined AS (
            UPDATE workspace_invitation invitation
            SET status = 'revoked', revoked_at = @now
            WHERE invitation.tenant_id = @tenant_id AND invitation.workspace_id = @workspace_id
              AND invitation.invitation_id = @invitation_id AND invitation.status = 'pending'
              AND invitation.target_principal_id = @principal_id
            RETURNING invitation.invitation_id
        ), membership AS (
            DELETE FROM workspace_member member
            USING declined
            WHERE member.tenant_id = @tenant_id AND member.workspace_id = @workspace_id
              AND member.subject_type = 'principal' AND member.subject_id = @principal_id
        )
        SELECT invitation_id FROM declined
        """;

    /// <summary>
    /// Changes one direct member under a workspace row lock. The predicate protects the personal
    /// owner and requires another recoverable owner before a shared owner is demoted.
    /// </summary>
    public const string ChangeMemberRole = """
        WITH locked_workspace AS MATERIALIZED (
            SELECT w.personal_owner_principal_id
            FROM workspace w
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND (EXISTS (SELECT 1 FROM workspace_member caller
                           WHERE caller.tenant_id = w.tenant_id AND caller.workspace_id = w.workspace_id
                             AND caller.role = 'owner'
                             AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                               OR (caller.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                     AND gm.principal_id = @principal_id))))
                OR EXISTS (SELECT 1 FROM tenant_role tr WHERE tr.tenant_id = w.tenant_id
                             AND tr.role = 'admin'
                             AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                               OR (tr.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                     AND gm.principal_id = @principal_id)))))
            FOR UPDATE
        )
        UPDATE workspace_member target SET role = @role, granted_by = @principal_id, granted_at = @now
        FROM locked_workspace w
        WHERE target.tenant_id = @tenant_id AND target.workspace_id = @workspace_id
          AND target.subject_type = 'principal' AND target.subject_id = @target_principal_id
          AND NOT EXISTS (
              SELECT 1 FROM workspace_invitation invitation
              WHERE invitation.tenant_id = target.tenant_id
                AND invitation.workspace_id = target.workspace_id
                AND invitation.target_principal_id = target.subject_id
                AND invitation.status = 'pending')
          AND w.personal_owner_principal_id IS DISTINCT FROM target.subject_id
          AND (w.personal_owner_principal_id IS NULL OR @role <> 'owner')
          AND (@role <> 'owner' OR EXISTS (
              SELECT 1 FROM principal p WHERE p.tenant_id = target.tenant_id
                AND p.principal_id = target.subject_id AND p.kind = 'user' AND p.status = 'active'))
          AND (target.role <> 'owner' OR @role = 'owner' OR EXISTS (
              SELECT 1 FROM workspace_member other
              JOIN principal p ON p.tenant_id = other.tenant_id AND p.principal_id = other.subject_id
              WHERE other.tenant_id = target.tenant_id AND other.workspace_id = target.workspace_id
                AND other.subject_type = 'principal' AND other.role = 'owner'
                AND other.subject_id <> target.subject_id AND p.kind = 'user' AND p.status = 'active'))
        RETURNING target.subject_id
        """;

    /// <summary>Removes a direct member with the same protected-owner and last-owner rules.</summary>
    public const string RemoveMember = """
        WITH locked_workspace AS MATERIALIZED (
            SELECT w.personal_owner_principal_id
            FROM workspace w
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND (@self OR EXISTS (SELECT 1 FROM workspace_member caller
                           WHERE caller.tenant_id = w.tenant_id AND caller.workspace_id = w.workspace_id
                             AND caller.role = 'owner'
                             AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                               OR (caller.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                     AND gm.principal_id = @principal_id))))
                OR EXISTS (SELECT 1 FROM tenant_role tr WHERE tr.tenant_id = w.tenant_id
                             AND tr.role = 'admin'
                             AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                               OR (tr.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                     AND gm.principal_id = @principal_id)))))
            FOR UPDATE
        )
        DELETE FROM workspace_member target USING locked_workspace w
        WHERE target.tenant_id = @tenant_id AND target.workspace_id = @workspace_id
          AND target.subject_type = 'principal' AND target.subject_id = @target_principal_id
          AND NOT EXISTS (
              SELECT 1 FROM workspace_invitation invitation
              WHERE invitation.tenant_id = target.tenant_id
                AND invitation.workspace_id = target.workspace_id
                AND invitation.target_principal_id = target.subject_id
                AND invitation.status = 'pending')
          AND (NOT @self OR target.subject_id = @principal_id)
          AND w.personal_owner_principal_id IS DISTINCT FROM target.subject_id
          AND (target.role <> 'owner' OR EXISTS (
              SELECT 1 FROM workspace_member other
              JOIN principal p ON p.tenant_id = other.tenant_id AND p.principal_id = other.subject_id
              WHERE other.tenant_id = target.tenant_id AND other.workspace_id = target.workspace_id
                AND other.subject_type = 'principal' AND other.role = 'owner'
                AND other.subject_id <> target.subject_id AND p.kind = 'user' AND p.status = 'active'))
        RETURNING target.subject_id
        """;

    /// <summary>Tenant-admin recovery converts a personal workspace to shared and installs an active human owner.</summary>
    public const string Recover = """
        WITH administrator AS MATERIALIZED (
            SELECT 1 FROM tenant_role tr
            WHERE tr.tenant_id = @tenant_id AND tr.role = 'admin'
              AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                OR (tr.subject_type = 'group' AND EXISTS (
                    SELECT 1 FROM group_membership gm
                    WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                      AND gm.principal_id = @principal_id)))
        ), locked_workspace AS MATERIALIZED (
            SELECT w.workspace_id
            FROM workspace w
            JOIN principal protected_owner
              ON protected_owner.tenant_id = w.tenant_id
             AND protected_owner.principal_id = w.personal_owner_principal_id
            CROSS JOIN administrator
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND protected_owner.kind = 'user' AND protected_owner.status <> 'active'
            FOR UPDATE OF w
        ), replacement AS MATERIALIZED (
            SELECT p.principal_id FROM principal p, locked_workspace
            WHERE p.tenant_id = @tenant_id AND p.principal_id = @target_principal_id
              AND p.kind = 'user' AND p.status = 'active'
        ), converted AS (
            UPDATE workspace w SET personal_owner_principal_id = NULL
            FROM replacement, locked_workspace
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND w.workspace_id = locked_workspace.workspace_id
            RETURNING w.workspace_id
        ), membership AS (
            INSERT INTO workspace_member (
                workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            SELECT c.workspace_id, 'principal', r.principal_id, @tenant_id, 'owner', @principal_id, @now
            FROM converted c CROSS JOIN replacement r
            ON CONFLICT (workspace_id, subject_type, subject_id)
            DO UPDATE SET role = 'owner', granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at
        )
        SELECT workspace_id FROM converted
        """;

    /// <summary>Serializes creation attempts for one deterministic daily-note identifier.</summary>
    public const string LockDailyNote = "SELECT pg_advisory_xact_lock(hashtextextended(@item_id::text, 0))";

    /// <summary>Idempotently inserts a deterministic dated note below the deterministic root.</summary>
    public const string OpenDailyNote = """
        WITH authorized AS MATERIALIZED (
            SELECT root.id
            FROM item root
            WHERE root.tenant_id = @tenant_id AND root.workspace_id = @workspace_id
              AND root.id = @root_id AND root.lifecycle_state = 'active'
        ), inserted AS (
            INSERT INTO item (
                id, tenant_id, workspace_id, type, parent_id, seq, properties,
                lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            SELECT @item_id, @tenant_id, @workspace_id, 'note', a.id,
                   COALESCE((SELECT max(seq) + 1000 FROM item sibling
                             WHERE sibling.tenant_id = @tenant_id AND sibling.workspace_id = @workspace_id
                               AND sibling.parent_id = a.id), 1000),
                   jsonb_build_object('title', @date), 'active',
                   @principal_id, @principal_id, @now, @now
            FROM authorized a
            ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
              WHERE item.tenant_id = EXCLUDED.tenant_id
                AND item.workspace_id = EXCLUDED.workspace_id
                AND item.parent_id = EXCLUDED.parent_id
            RETURNING id
        ), closure AS (
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT i.id, i.id, @tenant_id, @workspace_id, 0 FROM inserted i
            UNION ALL
            SELECT i.id, parent.ancestor_id, @tenant_id, @workspace_id, parent.depth + 1
            FROM inserted i
            JOIN item_closure parent ON parent.descendant_id = @root_id AND parent.tenant_id = @tenant_id
            ON CONFLICT (descendant_id, ancestor_id) DO NOTHING
        )
        SELECT id FROM inserted
        """;
}
