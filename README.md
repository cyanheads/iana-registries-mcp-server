<div align="center">
  <h1>@cyanheads/iana-registries-mcp-server</h1>
  <p><b>Look up IANA ports, media types, HTTP status codes and fields, URI schemes, enterprise numbers, and BCP 47 language tags; check RFC status; search and read any IANA registry via MCP. STDIO or Streamable HTTP.</b>
  <div>10 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/iana-registries-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/iana-registries-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/iana-registries-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/iana-registries-mcp-server/releases/latest/download/iana-registries-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=iana-registries-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvaWFuYS1yZWdpc3RyaWVzLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22iana-registries-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fiana-registries-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Protocol parameters from the IANA registries, and document status from the RFC Editor and the IETF Datatracker. Look up ports, media types, HTTP status codes and fields, URI schemes, Private Enterprise Numbers, and BCP 47 language tags; check whether an RFC is current, obsoleted, or updated, and where an Internet-Draft stands; and search and read any other registry in the IANA protocol index. RFC answers are metadata only: the server never returns RFC text. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `iana_lookup_port` | Service name and port assignments by port number, service name, or keyword, per transport, with the port's RFC 6335 class |
| `iana_lookup_media_type` | Registered media (MIME) types by exact type or keyword, with status, replacement, and registration-template statements |
| `iana_lookup_http_status` | An HTTP status code by number, or reason phrases by keyword; an unassigned code reports its range |
| `iana_lookup_http_field` | Registered HTTP field (header and trailer) names with status and Structured Field type |
| `iana_lookup_uri_scheme` | Registered URI schemes with status, description, and well-known URI support |
| `iana_lookup_pen` | Private Enterprise Numbers by number or OID under `1.3.6.1.4.1`, or by organization name |
| `iana_lookup_language_tag` | Validate and canonicalize a BCP 47 language tag subtag by subtag, or search subtags by description |
| `iana_get_rfc_status` | Current status and relations of up to 10 RFCs or Internet-Drafts per call |
| `iana_search_registries` | Find any registry or sub-registry in the IANA protocol index by keyword |
| `iana_get_registry_records` | Read and filter the records of any IANA XML registry by id |

## Capability reference

### `iana_lookup_port` <sub>tool</sub>

- One of `port` (0–65535), `service` (exact name), or `keyword`; `transport` (`tcp`, `udp`, `sctp`, `dccp`) filters every mode
- Each row carries `state` (`assigned`, `reserved`, `unassigned`, `unnamed`) and its transport; port mode adds `port_class` (`system`, `user`, `dynamic`) and the range rows that contain the port

---

### `iana_lookup_media_type` <sub>tool</sub>

- One of `type` (e.g. `application/json`; parameters after `;` are dropped) or `keyword`; `top_level` narrows keyword mode
- `status` is `current`, `deprecated`, or `obsoleted`, with `replaced_by` when the registry names a replacement
- `type` mode also reads the registration template and returns its file-extension, intended-usage, and deprecated-alias statements under `template`; `template.fetched` is `false` when the template can't be read

---

### `iana_lookup_http_status` <sub>tool</sub>

- One of `code` (100–599) or `keyword` over registered reason phrases
- Returns `class` and `state` (`assigned`, `temporary`, `obsoleted`, `unused`) with the defining reference and section; an unassigned code returns `found: false` and its `unassigned_range`

---

### `iana_lookup_http_field` <sub>tool</sub>

- One of `name` (case-insensitive) or `keyword` over names and comments; `status` filters both modes
- Returns `status` (`permanent`, `provisional`, `deprecated`, `obsoleted`), `structured_type` when one is registered, comments, and the defining reference

---

### `iana_lookup_uri_scheme` <sub>tool</sub>

- One of `scheme` (a trailing `:` or `://` is ignored) or `keyword`; `status` (`permanent`, `provisional`, `historical`) filters both modes
- Returns the description, references, `well_known_uri_support`, and `template_url` when a registration template is published

---

### `iana_lookup_pen` <sub>tool</sub>

- One of `pen` (a number, or an OID under `1.3.6.1.4.1`) or `organization` words
- Each entry carries its `oid` prefix and `state` (`assigned`, `reserved`, `unassigned`); `organization_withheld: true` marks an organization line held back because it mixes in contact details
- An OID with arcs below the enterprise number echoes `requested_oid` and `sub_arcs`; those arcs are assigned by the enterprise, not IANA

---

### `iana_lookup_language_tag` <sub>tool</sub>

- One of `tag` (underscores read as hyphens) or `description`; `subtag_type` narrows description mode
- Tag mode returns `well_formed`, `valid`, `canonical_tag` (valid tags only), each part in `subtags[]`, and `issues[]`: `kind` `unknown` and `wrong_position` make a tag invalid, while `deprecated`, `variant_prefix_mismatch`, `suppress_script_redundant`, and `extension_not_validated` are advisory
- A single-subtag input lists records of other types under the same subtag in `also_registered_as`

---

### `iana_get_rfc_status` <sub>tool</sub>

- Up to 10 `ids` per call: RFC numbers in any common form, RFC Editor or Datatracker URLs, and draft names with or without a revision suffix; BCP, STD, and FYI numbers come back as `kind: "unsupported"`
- `documents[]` gives RFCs their current and as-published status, stream, group, obsoletes and updates relations, and errata page, and gives drafts their state, IESG state, replacements, and `became_rfc`; an unknown id is `found: false` with `guidance`
- An id whose upstream lookup fails lands in `failed[]` while the rest still answer; the call fails only when every id failed

---

### `iana_search_registries` <sub>tool</sub>

- `query` words matched against registry titles, categories, and ids, with an exact registry or sub-registry id ranked first; `limit` 1–50, default 15, paged by `offset`
- Each entry carries the `registry_id` and `subregistry_id` that `iana_get_registry_records` reads, plus registration procedure, defining documents, and page and XML URLs

---

### `iana_get_registry_records` <sub>tool</sub>

- A `registry` id or `iana.org/assignments` URL, optional `subregistry`, and filters `value` (exact match on the key column; a decimal also matches range rows) and `contains` (words in any field)
- Pages by `cursor` / `next_cursor` within `limit` (1–100, default 25) and a 48,000-character records budget; a field over 2,000 characters is cut, a record keeps at most 16 fields, and `cut_fields` names what was cut
- A registry with several sub-registries and none chosen returns `subregistries[]` instead of records; failures carry `unknown_registry`, `unknown_subregistry`, `non_xml_registry`, `invalid_cursor`, or `cursor_mismatch`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

IANA-specific:

- Live, keyless reads of the IANA registry files, the RFC Editor's per-RFC JSON, and the IETF Datatracker
- Each registry loads on first use and stays cached for 24 hours before revalidating; when a refresh fails, a cached copy up to 7 days old answers with `source.stale: true`
- Self-imposed request pacing per host (iana.org, rfc-editor.org, datatracker.ietf.org) and one 45-second budget per tool call that covers every retry and queue wait
- Generic records keep the registry's XML element names as field names (`rec` is the Recommended column); the registry notes returned on the first page usually explain them
- Contact, designated-expert, and registrant-person fields are dropped by design, and email addresses in free text are replaced with `[email removed]`

Agent-friendly output:

- Misses are results, not errors: a lookup that finds nothing returns `found: false` with a `notice` naming the next step, an unknown RFC or draft returns `found: false` with `guidance`, and an invalid language tag returns `valid: false` with its `issues[]`. A miss means IANA has no registration, not that a value is unused in practice
- Uniform lookup contract: every lookup takes exactly one mode key and fails `mode_required` otherwise; `limit` is 1–100, default 25, and the list modes (`keyword`, `organization`, `description`) page with `offset` and return `next_offset`, alongside `totalCount`, `shown`, and `truncated`
- Provenance on every registry response: `source` names the registry file, `registry_updated` (the registry's own last-updated date), `fetched_at`, and `stale`
- Typed failures with recovery hints: every tool declares `upstream_unreadable` (`index_unreadable` for search) and `pacer_shed`, which carries `retryAfter` when this server's own request queue is full

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "iana-registries-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/iana-registries-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "iana-registries-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/iana-registries-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "iana-registries-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/iana-registries-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

One server process paces its requests to each upstream for all of its clients together, so a deployment serving several clients should rate-limit each client at its edge (a reverse proxy or gateway).

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key or account: IANA, the RFC Editor, and the IETF Datatracker are all keyless.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/iana-registries-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd iana-registries-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# the server needs no variables of its own; edit framework overrides as needed
```

## Configuration

The server reads no environment variables of its own. These framework settings apply:

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_HOST` | HTTP server host. | `127.0.0.1` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path. | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of framework overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers the tools and starts and stops the services. |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`), ten tools. |
| `src/mcp-server/tools/shared` | Schemas, list paging and notices, and markdown helpers the tools share. |
| `src/services/upstream` | Paced, budgeted HTTP client for iana.org, rfc-editor.org, and datatracker.ietf.org. |
| `src/services/registry` | Registry cache and parsers: XML registries, the PEN list, the language subtag registry, the protocol index, BCP 47 tag analysis, and personal-data scrubbing. |
| `src/services/media-template` | Media type registration template reader. |
| `src/services/ietf` | RFC Editor and Datatracker document status. |
| `tests/` | Unit and tool tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging; registry text is third-party, so `format()` renders it through the `quote()` and `inline()` helpers
- Register new tools in the barrel at `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

IANA and the IETF Trust dedicate the protocol registries to the public domain under CC0 1.0 ([licensing terms](https://www.iana.org/help/licensing-terms), joint statement of 10 November 2021). RFC documents are excluded from that statement; this server returns RFC metadata only, never RFC text. This project is independent of IANA, the IETF, and the RFC Editor.
