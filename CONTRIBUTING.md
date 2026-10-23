# Contributing

Thanks for looking. Bug reports, ideas and pull requests are all welcome.

## Questions and ideas

Use [Discussions](https://github.com/kolganovr/figma-mcp-bridge/discussions). Bugs go to
[Issues](https://github.com/kolganovr/figma-mcp-bridge/issues) with the output of
`npx @kolganovr/figma-mcp-bridge --doctor`.

## Running it from a clone

```bash
git clone https://github.com/kolganovr/figma-mcp-bridge.git
cd figma-mcp-bridge
node install.mjs          # copies server + plugin, registers the MCP server
node install.mjs --doctor # checks the setup
```

Import the plugin into Figma Desktop from the manifest path the installer prints, not from `figma-plugin/` in
the clone: only the installed copy carries the bridge token.

## Tests

Node 18+ and nothing else. Every suite runs with bare `node`:

```bash
for f in tests/*.test.js; do node "$f"; done
```

CI runs the same loop on Ubuntu and Windows, Node 18 and 22. A pull request should keep all suites green and
add a check for the behaviour it changes.

## Ground rules

- **Zero runtime dependencies.** `dependencies` in `package.json` stays empty. The server executes JS inside
  design files, so there is no supply chain to audit, and that is on purpose.
- **Token cost is a feature.** Tool descriptions and server instructions are sent to the model on every turn.
  Making them longer needs a reason; making a reply smaller or saving a model turn is a good reason for a change.
- **Errors tell the agent what to do.** A new failure mode gets a stable `code` and a `HINT:` line.
- Keep the code style of the file you touch. Comments explain why, not what.
- One topic per pull request. Update `CHANGELOG.md` under "Unreleased".

## Where things live

- `figma/index.js`: MCP server, tool schemas, router, job ledger, WebSocket.
- `figma/optimizer/`: token-optimized serializers (Pseudo-JSX, tree).
- `figma-plugin/code.js`: sandbox executor, `bridge` runtime, checkpoints, capture.
- `install.mjs`: installer, updater, doctor.
- `docs/GUIDE.md`: long-form guide for agents.
