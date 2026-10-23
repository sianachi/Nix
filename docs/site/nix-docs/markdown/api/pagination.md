# Pagination

Collection routes that return a page use a cursor. The query parameters are `cursor` and `limit`. The page is:

```json
{ "items": [], "nextCursor": null }
```

`nextCursor` is present and null on the last page. Pass the cursor back exactly. Clients do not build or decode one. A cursor that is malformed or longer than 512 characters fails with `paging.invalid_cursor` (422).

The shared default is default 50 and at most 200.

Lists do not all treat an out-of-range `limit` the same way:

- **Workspaces** (`GET /api/v1/workspaces`) and the membership lists that share that check reject `limit` outside 1 to 200 with `paging.invalid_cursor` (422). A bad cursor uses the same code.
- **Item children** (`GET /api/v1/workspaces/{workspaceId}/items`) clamp `limit` into 1 to 200 and return a page. Asking for more than the ceiling returns 200 items and a cursor, not an error.

Workspace query is a different ceiling. `POST /api/v1/workspaces/{workspaceId}/query` uses default 100 and at most 500. The response says when the match was cut. The aggregate route uses that same ceiling. Those calls are reads and have their own rate limit, described in [Rate limits](rate-limits.md).

Search clamps its own `limit` (the route description in the reference states the cap for that call). It does not use the cursor page.

## Properties

- title: Pagination
