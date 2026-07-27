import { Table, type TableColumn } from '@nix/ui';
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

/**
 * One row of the audit trail, as the export goal will eventually hand it over.
 *
 * The shape is declared even though nothing produces it yet, so the columns below are the columns
 * of a real table rather than four strings: when the read path lands, this file gains rows and
 * nothing else.
 */
interface AuditEvent {
  readonly id: string;
  readonly occurred: string;
  readonly actor: string;
  readonly action: string;
  readonly subject: string;
}

const COLUMNS: readonly TableColumn<AuditEvent>[] = [
  { key: 'occurred', header: 'Occurred', cell: (event) => event.occurred, rowHeader: true },
  { key: 'actor', header: 'Actor', cell: (event) => event.actor },
  { key: 'action', header: 'Action', cell: (event) => event.action },
  { key: 'subject', header: 'Subject', cell: (event) => event.subject },
];

const NO_EVENTS =
  'No events can be shown. The audit trail is insert-only for this application: it can write ' +
  'events and cannot read them back, by design. A read path needs its own role or a ' +
  'security-definer view, which the audit export goal owns.';

export function AuditPage(): ReactNode {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-divider px-6 py-3">
        <span className="font-heading text-md uppercase tracking-[0.06em]">Admin · Audit</span>
        <span className="text-xs text-muted">Tenant admin</span>
      </div>

      <div className="p-6">
        <Table
          caption="Audit events recorded for this tenant"
          columns={COLUMNS}
          rows={[]}
          rowKey={(event) => event.id}
          emptyMessage={NO_EVENTS}
        />
      </div>
    </div>
  );
}
