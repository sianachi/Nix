# Workspaces, containers, and cards

Nix has one kind of item. A workspace holds a tree of items. A container is an item you treat as a parent: it has children, and it can carry the fields and views those children share. A card on a board, gallery, or matrix is one of those children. It does not have a second id.

All three identifiers in API paths are UUIDs.

## Workspace id

`GET /api/v1/workspaces` returns each workspace's `id`. In the web app the address is:

```text
https://<origin>/w/<workspace-id>
```

That path segment is the `workspaceId` used on routes such as `GET /api/v1/workspaces/{workspaceId}/items`.

## Container id

A container is an item. Its id is the item id.

- In the app, open the container and choose **Copy link**. The link is `https://<origin>/w/<workspace-id>?item=<item-id>`. The `item` query value is the container id.
- `GET /api/v1/workspaces/{workspaceId}/items` with no `parentId` lists the workspace roots. Each object's `id` is an item id. `hasChildren` is true when it holds items.
- `GET /api/v1/items/{itemId}` returns one item, including `workspaceId`, `parentId`, `type`, and `title`.

Fields and views belong to the container item:

- `GET /api/v1/items/{itemId}/schema` reads the fields children inherit.
- `GET /api/v1/items/{itemId}/views` reads the saved views (list, board, calendar, and the rest).
- `GET /api/v1/workspaces/{workspaceId}/items?parentId=<container-id>` lists the children, which are the rows, cards, and events those views show.

`parentId` null means the item sits at the workspace root.

## Card id

A board column groups child items by a property. Each card is that child item. The id on the card is `id` from the child, the same id **Copy link** puts in `?item=`.

To take a card off a board, list the container's children and use the child's `id` with the item routes: rename with `PATCH /api/v1/items/{itemId}`, set fields with `PATCH /api/v1/items/{itemId}/properties`, move it with `POST /api/v1/items/{itemId}/move`. None of those calls edit the note body.

The same is true of a gallery card and a matrix card. Calendar entries and task rows are also items. When a guide says "the task" or "the habit", the id to send is that item's id.

## Where the ids appear

| Id | In the app | In the API |
| --- | --- | --- |
| Workspace | `/w/<workspace-id>` | `id` on `GET /api/v1/workspaces` |
| Container | **Copy link**, the `item` parameter, on the parent | `id` of that item; pass it as `parentId` to list children, and as `itemId` to read schema and views |
| Card | **Copy link** on the card | `id` of the child from the container's item list |

An item the caller cannot read is omitted or reported as not found. A locked item the caller has not opened withholds its children (`items.locked`, 423).

## Properties

- title: Workspaces, containers, and cards
