# Security

## What this bridge can do

`figma_execute_code` runs JavaScript inside the Figma plugin sandbox of the open file. Anything the Figma
Plugin API allows (reading, creating, editing, deleting nodes in that file) an agent can do through it. Treat
connecting an agent to the bridge like giving it edit access to the files you open while the plugin runs.

Limits that apply:

- The server listens on loopback (`127.0.0.1:8765`) only.
- The WebSocket handshake checks `Origin` against an allowlist, so a web page in your browser cannot connect.
- `install.mjs` generates a shared token and writes it into both the MCP config and the installed plugin;
  connections without it are rejected. Running from a clone without a token keeps the Origin check and prints
  a warning.
- The only outbound request the server makes on its own is an update check against the GitHub API
  (`FIGMA_MCP_NO_UPDATE_CHECK=1` turns it off). REST tools call api.figma.com only when you set a token.
- Writes are checkpointed: `figma_rollback` removes nodes a call created and restores snapshotted properties.
  Deletions cannot be undone by the bridge; use Figma's version history.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting:
[Report a vulnerability](https://github.com/kolganovr/layerhand/security/advisories/new).
You will get a reply within a few days. Fixes go out as a patch release with a note in `CHANGELOG.md`.

## Supported versions

Only the latest release on npm (`layerhand`) gets security fixes.
