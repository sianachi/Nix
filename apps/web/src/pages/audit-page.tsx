import { type ReactNode } from 'react';

/**
 * The admin audit screen, per Fig. Admin · Audit of the design language.
 *
 * It renders an empty table and explains why, which is the only honest thing it can do: the audit
 * trail is insert-only for the application role, so nothing running as `nix_app` can read it. That
 * is deliberate - an audit trail the application can rewrite records only what an attacker who
 * reached the application was willing to leave behind - and the read path is a later goal's to
 * design, needing either its own role or a security-definer view.
 *
 * Showing a plausible-looking table of fake events would be the worst possible thing here.
 */
const COLUMNS = ['Occurred', 'Actor', 'Action', 'Subject'] as const;

export function AuditPage(): ReactNode {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-divider px-6 py-3">
        <span className="font-heading text-[15px] uppercase tracking-[0.06em]">Admin · Audit</span>
        <span className="text-[11px] text-foreground/60">Tenant admin</span>
      </div>

      <div className="p-6">
        <table className="w-full border border-divider text-left text-[13px]">
          <thead>
            <tr className="bg-neutral-100">
              {COLUMNS.map((column) => (
                <th
                  key={column}
                  scope="col"
                  className="border-b border-divider px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-foreground/70"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={COLUMNS.length} className="px-3 py-6 text-[12px] text-foreground/60">
                No events can be shown. The audit trail is insert-only for this application: it can
                write events and cannot read them back, by design. A read path needs its own role or
                a security-definer view, which the audit export goal owns.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
