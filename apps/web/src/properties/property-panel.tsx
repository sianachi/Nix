import { Text } from '@nix/ui';
import { useId, useState, type ReactNode } from 'react';

import { EmptyPanel, LoadingPanel } from '../components/states/status-panels';
import type { Item, PropertyDefinition, PropertyValue } from '../views/container-model';
import { PropertyInput } from './property-input';

/**
 * An item's properties, on the item.
 *
 * Until now the only way to set a property was to drag a card on a board or on a calendar, which
 * writes the one property that view groups by. A note with a status and an owner had no way to
 * carry either from the note itself; this is that way.
 *
 * **The panel writes one property per request, and only the one that changed.** The contract merges
 * - a member set to null clears that property, anything unmentioned is left alone - so there is no
 * reason to send the whole bag back and every reason not to: sending properties nobody touched
 * would make one person's edit overwrite another's, and would turn a value this build could not
 * render into a value this build deleted.
 *
 * **Which properties appear is not this component's decision.** They come from the folder the item
 * is in and from the folders above it, which is exactly what the empty state has to say - otherwise
 * "no properties" reads as a fault rather than as a folder that has not declared any.
 */

export interface PropertyPanelProps {
  readonly item: Item;

  /** The effective schema's properties: what this item declares plus what it inherits. */
  readonly properties: readonly PropertyDefinition[];

  /**
   * Stores the changed properties and answers with the reason they were refused, or null when they
   * were stored.
   *
   * A reason rather than a boolean, because the server names the property at fault and somebody has
   * to be shown that sentence - "false" cannot say which property is wrong or why.
   */
  readonly onChange: (changes: Record<string, unknown>) => Promise<string | null>;

  /** The schema has not arrived yet. Distinct from a folder that declares nothing. */
  readonly loading?: boolean;

  /** No write is permitted from here - a read-only share, say. */
  readonly disabled?: boolean;
}

/**
 * The title is not a property this panel edits.
 *
 * It is on the item itself and the rename path owns it; offering a second control for it here would
 * be a second way to write one field, and the two would disagree the first time one of them lost a
 * race. The server refuses to have it redeclared for the same reason.
 */
const TITLE_KEY = 'title';

interface Refusal {
  readonly key: string;
  readonly reason: string;
}

export function PropertyPanel(props: PropertyPanelProps): ReactNode {
  const { item, properties, onChange, loading = false, disabled = false } = props;

  const headingId = useId();
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  if (loading) {
    return <LoadingPanel label="this item's properties" />;
  }

  const editable = properties.filter((property) => property.key !== TITLE_KEY);

  if (editable.length === 0) {
    return (
      <EmptyPanel
        title="No properties here"
        detail="Properties come from the item this one is in, and from the items above it. None of them declares any yet, so there is nothing to fill in - add a property further up and it appears here."
      />
    );
  }

  async function commit(key: string, value: PropertyValue): Promise<void> {
    setSaving(key);
    setRefusal(null);

    const reason = await onChange({ [key]: value });

    setSaving(null);

    if (reason !== null) {
      // Verbatim, and attached to the property it is about. The server names the property at fault;
      // rewording it here would be a second validator that can disagree with the first, and a
      // panel-wide banner would leave somebody hunting for which field it meant.
      setRefusal({ key, reason });
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={saving !== null}
      className="flex flex-col gap-4 border border-divider p-4"
    >
      <Text variant="h6" as="h2" id={headingId}>
        Properties
      </Text>

      {editable.map((property) => (
        <PropertyInput
          key={property.key}
          item={item}
          property={property}
          disabled={disabled}
          error={refusal?.key === property.key ? refusal.reason : null}
          onCommit={(value) => {
            void commit(property.key, value);
          }}
        />
      ))}
    </section>
  );
}
