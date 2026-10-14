# Plugins and MCP

## Plugins

Nix runs plugins as signed WebAssembly components. A plugin is registered on a workspace with a declared set of capabilities, and it reacts to workspace events.

- **Declared capabilities.** A plugin can only make the host calls its installation grants. Capabilities can be changed later, and a plugin can be disabled without being removed.
- **Bounded execution.** Each run is limited in module size, memory, time and the number of host calls. The defaults are an 8 MiB module, 64 MiB of memory, 250 milliseconds and 32 host calls. A run that exceeds a limit fails visibly.
- **No database access.** Plugins run in a dedicated worker that has no database credentials. Every action a plugin takes is checked by the server like any other request.
- **Safe retries.** Duplicate events and retries do not repeat a plugin's changes.

Plugins are managed through the workspace plugins API. There is no public marketplace.

## MCP server

`nixctl mcp` starts a Model Context Protocol server over stdio, so agent tools that speak MCP can work in your workspace. It runs as you, with your profile's token, and can never reach further than you can.

Add it to an MCP client's configuration like this:

```json
{
  "mcpServers": {
    "nix": {
      "command": "nixctl",
      "args": ["--profile", "default", "mcp"]
    }
  }
}
```

Use a personal access token with only the scopes the agent needs. A `read` token cannot change anything; automations and other administrative changes need `admin`.

The server offers tools for:

- workspaces, invitations and members;
- templates: browse, preflight, capture, apply, import and export;
- document import with preview, commit and cancel;
- files: upload, replace, list versions and download;
- structures and blueprints: read, validate, describe and build;
- finance: accounts, loans, transactions, schedules, statements and budgets;
- habits: definitions, status, check-ins and undo;
- notifications, reminders and automations;
- calendar links and sync logs;
- item protection;
- the companion pet.

General item reading and editing, note bodies and search stay as `nixctl` commands. Tool inputs are validated before they reach the server, and errors carry the server's explanation, including which token scope a refused call needed.

Tool results are data. Note contents and filenames that come back from a tool never grant an agent new authority.

## HTTP and other clients

By default `nixctl mcp` speaks stdio and uses your saved CLI profile. To run it against a different account without a profile, set `NIX_SESSION_TOKEN` and `NIX_API_URL` in the client's environment.

`nixctl mcp` can also serve the same tools over HTTP, for clients that cannot start a local process:

```sh
nixctl mcp --listen 127.0.0.1:8765 --api-url https://<your-nix-host>
```

- **Flags.** `--listen <host:port>` (or `NIX_MCP_LISTEN`) turns HTTP on. `--api-url` (or `NIX_API_URL`) is required and names your Nix server. `--collab-url` (or `NIX_COLLAB_URL`) is optional and names the collaboration service.
- **Endpoint.** The server is stateless Streamable HTTP at the path `/mcp`.
- **Authentication.** Every request needs `Authorization: Bearer nixpat_...`, a personal access token. Requests without one get a 401. The server keeps no profile, so each call runs with that token's scopes and nothing more.
- **Fewer tools.** Six tools that read or write files on the machine running `nixctl` are not offered over HTTP: document import, file upload, file replace, file download, template archive import preview and template archive export. Use stdio for those.

Some deployments already serve MCP at a public address. If yours does, Settings, MCP shows the URL and a ready-made command, and lets you create a token for it.

### Claude Code

Over stdio, with your saved profile:

```sh
claude mcp add nix -- nixctl mcp
```

Over HTTP:

```sh
claude mcp add --transport http nix https://<your-nix-host>/mcp --header "Authorization: Bearer <token>"
```

### Codex CLI

Add the server to `~/.codex/config.toml`. For stdio:

```toml
[mcp_servers.nix]
command = "nixctl"
args = ["mcp"]
```

For HTTP, keep the token in an environment variable rather than in the file:

```toml
[mcp_servers.nix]
url = "https://<your-nix-host>/mcp"
bearer_token_env_var = "NIX_MCP_TOKEN"
```

### Other clients

A client that launches local servers takes the stdio form shown above. A client that connects by URL needs the address and the bearer header:

```json
{
  "mcpServers": {
    "nix": {
      "url": "https://<your-nix-host>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

The exact key names differ between clients, so check yours. Clients that can only connect through an OAuth sign-in are not supported yet; the server accepts personal access tokens only.
