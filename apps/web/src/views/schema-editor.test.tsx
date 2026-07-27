import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { EffectiveSchema, PropertyDefinition } from './container-model';
import { aContainer } from './container-fixture';
import { SchemaEditor } from './schema-editor';
import type { ContainerData, SchemaDraft } from './use-container';

/**
 * Declaring properties on a folder.
 *
 * The assertion that matters most is the inheritance one: this editor must save only what the
 * folder declares itself. Bound to the merged schema instead, saving would copy every inherited
 * property onto this folder and sever it from the parent that owns it - a change nobody asked for,
 * visible only later when editing the parent stopped reaching anything.
 */

function propertyOf(overrides: Partial<PropertyDefinition> & { key: string }): PropertyDefinition {
  return {
    label: overrides.key,
    type: 'text',
    options: [],
    required: false,
    ...overrides,
  };
}

function containerOf(
  schema: EffectiveSchema | null,
  setSchema: (draft: SchemaDraft) => Promise<string | null> = () => Promise.resolve(null),
): ContainerData {
  return aContainer({ schema, setSchema });
}

describe('the schema editor', () => {
  it('shows the properties this folder declares', () => {
    render(
      <SchemaEditor
        container={containerOf({
          properties: [propertyOf({ key: 'status', label: 'Status' })],
          declared: [propertyOf({ key: 'status', label: 'Status' })],
          inherit: true,
        })}
        open
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: /name/i })).toHaveValue('Status');
  });

  it('shows an inherited property without offering to edit it', () => {
    render(
      <SchemaEditor
        container={containerOf({
          properties: [propertyOf({ key: 'owner', label: 'Owner' })],
          declared: [],
          inherit: true,
        })}
        open
        onClose={vi.fn()}
      />,
    );

    // Visible, so a person can see why a property they did not declare appears on their notes -
    // and not in a field, so they cannot accidentally claim it.
    expect(screen.getByText(/inherited from above/i)).toBeVisible();
    expect(screen.getByText(/Owner · text/)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /name/i })).not.toBeInTheDocument();
  });

  it('saves only what this folder declares, never what it inherits', async () => {
    const user = userEvent.setup();
    const setSchema = vi.fn(() => Promise.resolve(null));

    render(
      <SchemaEditor
        container={containerOf(
          {
            properties: [
              propertyOf({ key: 'owner', label: 'Owner' }),
              propertyOf({ key: 'status', label: 'Status' }),
            ],
            declared: [propertyOf({ key: 'status', label: 'Status' })],
            inherit: true,
          },
          setSchema,
        )}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /save properties/i }));

    // Saving the merged list would copy Owner onto this folder and silently turn inheritance into
    // a copy, after which changing the parent would stop reaching anything below.
    expect(setSchema).toHaveBeenCalledWith({
      inherit: true,
      properties: [expect.objectContaining({ key: 'status' })],
    });
  });

  it('adds a property and derives its key from its name', async () => {
    const user = userEvent.setup();
    const setSchema = vi.fn(() => Promise.resolve(null));

    render(
      <SchemaEditor
        container={containerOf({ properties: [], declared: [], inherit: true }, setSchema)}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /add a property/i }));
    await user.type(screen.getByRole('textbox', { name: /name/i }), 'Due date');
    await user.click(screen.getByRole('button', { name: /save properties/i }));

    expect(setSchema).toHaveBeenCalledWith({
      inherit: true,
      properties: [expect.objectContaining({ key: 'due_date', label: 'Due date' })],
    });
  });

  it('offers an options box only for the types that have options', async () => {
    const user = userEvent.setup();

    render(
      <SchemaEditor
        container={containerOf({ properties: [], declared: [], inherit: true })}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /add a property/i }));
    expect(screen.queryByRole('textbox', { name: /options/i })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'select');
    expect(screen.getByRole('textbox', { name: /options/i })).toBeVisible();
  });

  it('does not send options for a type that cannot carry them', async () => {
    const user = userEvent.setup();
    const setSchema = vi.fn(() => Promise.resolve(null));

    render(
      <SchemaEditor
        container={containerOf({ properties: [], declared: [], inherit: true }, setSchema)}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /add a property/i }));
    await user.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'select');
    await user.type(screen.getByRole('textbox', { name: /options/i }), 'Todo\nDone');
    await user.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'text');
    await user.click(screen.getByRole('button', { name: /save properties/i }));

    // Cleared at this boundary; the hook is what turns an empty list into the null the contract
    // wants. The server refuses a schema where a non-select carries options, so options left
    // behind after a type change would produce a refusal nobody typed.
    expect(setSchema).toHaveBeenCalledWith({
      inherit: true,
      properties: [expect.objectContaining({ type: 'text', options: [] })],
    });
  });

  it('removes a property', async () => {
    const user = userEvent.setup();
    const setSchema = vi.fn(() => Promise.resolve(null));

    render(
      <SchemaEditor
        container={containerOf(
          {
            properties: [propertyOf({ key: 'status', label: 'Status' })],
            declared: [propertyOf({ key: 'status', label: 'Status' })],
            inherit: true,
          },
          setSchema,
        )}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /remove status/i }));
    await user.click(screen.getByRole('button', { name: /save properties/i }));

    expect(setSchema).toHaveBeenCalledWith({ inherit: true, properties: [] });
  });

  it('shows the server s refusal verbatim and stays open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <SchemaEditor
        container={containerOf({ properties: [], declared: [], inherit: true }, () =>
          Promise.resolve("'title' is managed by the item itself and cannot be redeclared."),
        )}
        open
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole('button', { name: /save properties/i }));

    // Verbatim, because the server names the property at fault and second-guessing it here would
    // be a second validator that can disagree with the first.
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot be redeclared/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when the save is accepted', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <SchemaEditor
        container={containerOf({ properties: [], declared: [], inherit: true })}
        open
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole('button', { name: /save properties/i }));

    expect(onClose).toHaveBeenCalled();
  });

  it('can refuse everything from above', async () => {
    const user = userEvent.setup();
    const setSchema = vi.fn(() => Promise.resolve(null));

    render(
      <SchemaEditor
        container={containerOf(
          {
            properties: [propertyOf({ key: 'owner', label: 'Owner' })],
            declared: [],
            inherit: true,
          },
          setSchema,
        )}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole('checkbox', { name: /ignore properties from folders above/i }),
    );
    await user.click(screen.getByRole('button', { name: /save properties/i }));

    // The scratch-folder case: a subtree that would otherwise inherit a dozen required properties
    // and make every note in it invalid on arrival.
    expect(setSchema).toHaveBeenCalledWith({ inherit: false, properties: [] });
  });
});
