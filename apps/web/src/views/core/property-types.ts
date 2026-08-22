/**
 * What each property type is called when a person reads it.
 *
 * **One table, because the wire name is not a word anybody should be shown.** The contract stores
 * types as `multi_select`, `timestamp` and `image`; the interface calls them "Multi-select (any of
 * a list)", "Date and time" and "Picture". Three panels had grown their own answer to that - the
 * schema editor had this table, and the board and the gallery interpolated the raw token into a
 * sentence - so a person could be told their cover property "is now a multi_select field", with the
 * underscore, about a type they had chosen from a list that never used that word.
 *
 * The gallery makes the gap unmissable rather than merely untidy: it is the first type whose label
 * and wire name are different words entirely, so a hint saying "there is no image property yet"
 * sends somebody looking for "Image" in a list that only offers "Picture".
 */

/** The types a person may choose, and what to call them. */
export const PROPERTY_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'select', label: 'Select (one of a list)' },
  { value: 'multi_select', label: 'Multi-select (any of a list)' },
  { value: 'date', label: 'Date' },
  { value: 'timestamp', label: 'Date and time' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'url', label: 'Link' },
  // Told apart from a link because everything downstream reads them differently: a link is text
  // somebody clicks, and this is fetched and drawn by the browser without anybody deciding to. It
  // is also what lets a gallery offer covers from the properties that are pictures rather than
  // from every link in the workspace.
  { value: 'image', label: 'Picture' },
  // The task types (goal 3.1): the type carries the meaning, the value keeps the plain shape. A
  // schema declaring one of these is saying "this property IS the due date", which is what lets a
  // smart list or a timeline bind to the meaning instead of to a key-name convention.
  { value: 'due_date', label: 'Due date' },
  { value: 'start_date', label: 'Start date' },
  { value: 'completion', label: 'Completion' },
  { value: 'priority', label: 'Priority (1 to 4)' },
  { value: 'estimate', label: 'Estimate' },
  // Also goal 3.1's shape-versus-meaning split, arriving with 3.5: stored as a principal's
  // identifier, a canonical lowercase UUID string (or null when unassigned), so it shares its shape
  // with every other string property while its type says the string names a person.
  { value: 'assignee', label: 'Assignee' },
] as const;

/**
 * The value shape a type stores. The task types deliberately share their shape with the plain
 * types they refine - a due date is stored exactly as a date - so everything that handles values
 * (cell coercion, column widths, date pickers) asks for the shape and stays one switch, while
 * everything that handles meaning (smart lists, the recurrence anchor) asks for the type.
 */
export type PropertyValueShape =
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'date'
  | 'timestamp'
  | 'checkbox'
  | 'url'
  | 'image'
  | (string & {});

export function valueShapeOf(type: string): PropertyValueShape {
  switch (type) {
    case 'due_date':
    case 'start_date':
      return 'date';
    case 'completion':
      return 'checkbox';
    case 'priority':
    case 'estimate':
      return 'number';
    // A principal's identifier is stored exactly as a select's value is: a string, or null when
    // unset. The meaning - "this string names a person" - lives in the type, not the shape, which
    // is what keeps width and clearing on the same one switch as everything else string-shaped.
    case 'assignee':
      return 'text';
    default:
      return type;
  }
}

/**
 * Whether a property of this type can sit on a calendar or a timeline. The server's counterpart
 * is `PropertyTypes.CanPlaceOnCalendar` (PropertyType.cs); the two must widen together.
 */
export function isDateShaped(type: string): boolean {
  const shape = valueShapeOf(type);
  return shape === 'date' || shape === 'timestamp';
}

/**
 * What to call a type mid-sentence.
 *
 * Falls back to the stored name for a type this build does not know, which is the honest answer:
 * the type is real - a newer build declared it - and inventing a friendly word for it would be
 * making one up. The same open-set reasoning as `PropertyInput`'s read-only floor.
 */
export function propertyTypeLabel(type: string): string {
  return PROPERTY_TYPES.find((entry) => entry.value === type)?.label ?? type;
}

/**
 * The same word, lower case, for the middle of a sentence.
 *
 * "which is now a Date and time field" reads as a proper noun; "a date and time field" reads as
 * English. Only the first character moves, so "Multi-select" keeps its internal capital.
 */
export function propertyTypeWord(type: string): string {
  const label = propertyTypeLabel(type);
  return label.charAt(0).toLowerCase() + label.slice(1);
}
