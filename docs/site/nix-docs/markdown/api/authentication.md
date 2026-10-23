# Authentication

A personal access token lets a program act as the person who minted it. The token is not the bearer token the API expects on `/api/v1`. Exchange it first.

## Create a token

In the web app, open **Settings > Access tokens** and choose **Create token**.

- **Name.** Up to 100 characters, so the list shows what the token is for.
- **Scopes.** At least one of `read`, `write`, and `admin`. They are independent: `write` does not include `read`.
- **Expiry.** 1 to 365 days. There is no token without an expiry.

The response is the only time the secret appears. It starts with `nixpat_` and is 62 characters. Store it. The server keeps a hash. You can hold 25 live tokens. Revoked and expired rows stay in the list. Minting and revoking require an interactive browser session: a personal access token cannot call `/api/v1/me/tokens`.

A scope only narrows. Every request still checks the person's own permissions. A read-only token held by an owner reads what that person can read and writes nothing.

| Scope | What it allows |
| --- | --- |
| `read` | GET, plus the read-shaped POSTs for search mentions and workspace query. |
| `write` | Creating and editing items, properties, views, habit check-ins, and other content writes. |
| `admin` | Membership, invitations, permissions, moving an item, plugins, automations, sites, and publishing a view. |

Some routes refuse every token. Preferences, push subscriptions, calendar account connection, and minting tokens are an interactive session. The reference says which scope each operation requires.

## Base URL

`BASE` is the origin of Nix, with no path.

| Install | Base URL |
| --- | --- |
| Hosted | `https://nixsites.com` |
| Self-hosted | the origin you installed, such as `https://nix.example.org`. The one-line try-out is `http://nix.localhost`. |
| Local Core | `http://localhost:5014` |

On a deployed origin, Caddy forwards `/api/*` and `POST /public/v1/auth/token` to Core. During `pnpm dev`, the site on port 5173 forwards `/api` and does not forward `/public/v1/auth/token`. Call Core on port 5014 for the exchange.

## User-Agent

Send an explicit `User-Agent` on every request, including the exchange. The hosted edge blocks clients that send Python's or urllib's default user agent, so a script that works against a local Core can fail against `https://nixsites.com` until the header is set. The examples use `nix-api-example/1.0`. Pick a name that identifies your program.

## Exchange

`POST /public/v1/auth/token`

```json
{ "token": "nixpat_…" }
```

```json
{
  "accessToken": "<jwt>",
  "tokenType": "Bearer",
  "expiresInSeconds": 600
}
```

The JWT lifetime defaults to 10 minutes (`Nix:AccessTokens:LifetimeMinutes`). Exchange again before it runs out. The personal access token itself lasts until the expiry you chose or until you revoke it. Revocation applies on the next request: Core checks the token row every time, so an old JWT stops working when the row is revoked.

A wrong token is `auth.unauthenticated` (401). A token that used to work is `auth.token_revoked` or `auth.token_expired` (401). A person who can no longer act is `auth.principal_inactive` (403). A deployment with no signing key is `auth.exchange_unconfigured` (503). Too many guesses is `request.rate_limited` (429).

Later calls send:

```text
Authorization: Bearer <accessToken>
```

A token that is valid but missing the scope for the route is `auth.insufficient_scope`.

Signing keys are `GET /public/v1/auth/jwks` on Core. The collaboration service fetches them from Core inside the deployment. API clients do not need the key set; they present the JWT.

## curl

```sh
BASE=https://nixsites.com
SESSION=$(curl -sS "$BASE/public/v1/auth/token" \
  -A 'nix-api-example/1.0' \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$NIX_TOKEN\"}")
NIX_ACCESS_TOKEN=$(printf '%s' "$SESSION" | jq -r .accessToken)

curl -sS "$BASE/api/v1/workspaces" \
  -A 'nix-api-example/1.0' \
  -H "Authorization: Bearer $NIX_ACCESS_TOKEN"
```

## Python

The standard library is enough. `Request` sets `User-Agent` so urllib does not send its default.

```python
import json
import os
import urllib.request

base = os.environ.get("NIX_BASE", "https://nixsites.com")
token = os.environ["NIX_TOKEN"]


def call(path, method="GET", body=None, bearer=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {
        "User-Agent": "nix-api-example/1.0",
        "Accept": "application/json",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    request = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request) as response:
        return json.load(response)


session = call("/public/v1/auth/token", "POST", {"token": token})
workspaces = call("/api/v1/workspaces", bearer=session["accessToken"])
print(workspaces)
```

If you use `requests`, set the header there too. The library's default user agent is one the hosted edge blocks:

```python
import os
import requests

base = os.environ.get("NIX_BASE", "https://nixsites.com")
headers = {"User-Agent": "nix-api-example/1.0"}
session = requests.post(
    f"{base}/public/v1/auth/token",
    json={"token": os.environ["NIX_TOKEN"]},
    headers=headers,
    timeout=30,
)
session.raise_for_status()
access = session.json()["accessToken"]
workspaces = requests.get(
    f"{base}/api/v1/workspaces",
    headers={**headers, "Authorization": f"Bearer {access}"},
    timeout=30,
)
workspaces.raise_for_status()
print(workspaces.json())
```

## TypeScript

```ts
const base = process.env.NIX_BASE ?? 'https://nixsites.com';
const token = process.env.NIX_TOKEN;
if (token === undefined || token === '') {
  throw new Error('Set NIX_TOKEN to a personal access token.');
}

const headers = { 'User-Agent': 'nix-api-example/1.0', Accept: 'application/json' };

const exchange = await fetch(`${base}/public/v1/auth/token`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ token }),
});
if (!exchange.ok) {
  throw new Error(await exchange.text());
}
const session = (await exchange.json()) as {
  accessToken: string;
  expiresInSeconds: number;
};

const workspaces = await fetch(`${base}/api/v1/workspaces`, {
  headers: { ...headers, Authorization: `Bearer ${session.accessToken}` },
});
if (!workspaces.ok) {
  throw new Error(await workspaces.text());
}
console.log(await workspaces.json());
```

Re-exchange when `expiresInSeconds` has elapsed. A 401 with `auth.token_revoked` or `auth.token_expired` means the personal access token itself is finished.

## Properties

- title: Authentication
