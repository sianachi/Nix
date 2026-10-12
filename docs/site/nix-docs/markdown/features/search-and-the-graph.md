# Search and the graph

## References and backlinks

Type `[[` or `@` in a note to link to another item. The picker searches as you type, and a link to an item that has since been deleted or moved out of reach says so rather than pointing nowhere. Every item has a backlinks panel listing the notes that refer to it.

When you type the name of an existing item without linking it, Nix underlines it. Press **Alt+Enter** to turn it into a link.

## Search

**Mod+K** opens search and the command palette together. Search covers titles and note bodies across every item you can read. Results are filtered by your permissions as the query runs, so search never reveals an item you cannot open, or the titles inside a locked container.

From the command line:

```sh
nixctl search "trip planning" --limit 20
```

## The graph

The graph draws a workspace as its items and the references between them.

- Pan, zoom about a point and fit the whole graph to the window.
- Highlight an item's neighbourhood and dim the rest.
- Shape nodes by kind and size them by how often they are referenced.
- Filter by kind and text, and fold branches you do not need.
- Switch layouts, including a time view based on when items were created and changed.
- Save a graph view and come back to it later.

Calendar events imported by sync are left out of the graph so they do not drown out your notes.

