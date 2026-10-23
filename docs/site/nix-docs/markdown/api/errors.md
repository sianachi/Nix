# Errors

A failed call returns `Content-Type: application/problem+json`. The body is problem details plus two fields Nix always sets:

| Field | Meaning |
| --- | --- |
| `type` | The problem type URI the framework supplies. |
| `title` | A short summary of the class of failure. |
| `status` | The HTTP status. |
| `detail` | What happened on this call. |
| `instance` | The request path. |
| `code` | A stable machine-readable id. Branch on this, not on `detail`. |
| `traceId` | The trace id for this request. |

```json
{
  "title": "Not authenticated",
  "status": 401,
  "detail": "The presented value is not a personal access token that authenticates.",
  "instance": "/public/v1/auth/token",
  "code": "auth.unauthenticated",
  "traceId": "00-…"
}
```

`code` is never omitted. When the server has no feature code, it sends `api.unexpected_error`. A body over the limit is `request.body_too_large` (413). A rate limit is `request.rate_limited` (429) and includes `Retry-After`.

An item or workspace the caller cannot see is not found, not forbidden, so a guess learns nothing from the status. A missing scope on a token that is otherwise valid is `auth.insufficient_scope`.

The codes named in route descriptions, and the codes the server adds even when a description is quiet, are listed in [Error codes](error-codes.md). That list is generated from the OpenAPI document plus the codes defined for authentication, paging, and request limits.

## Properties

- title: Errors
