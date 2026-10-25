# SAP ADT MCP Server

A Model Context Protocol (MCP) server that exposes SAP ADT REST API operations as Claude tools. Enables Claude to read ABAP sources, query SAP tables/views, create/update CDS views, manage transport requests, and run MB5B-equivalent stock movement queries — all directly from a Claude chat session.

## Tools

| Tool | Description |
|------|-------------|
| `read_abap_source` | Read ABAP source (include, program, function, class, CDS view) |
| `query_sap` | Run SQL against any SAP table or CDS view via ADT Data Preview |
| `search_abap_objects` | Search repository objects by name pattern |
| `get_mb5b_equivalent` | Query MATDOC for stock movements (MB5B equivalent) |
| `get_movement_type_config` | Read T156S movement type sign/quantity config |
| `create_transport_request` | Create a new Workbench TR |
| `create_cds_view` | Create or update a CDS DDL source object |
| `activate_cds_view` | Activate a CDS DDL source object |

## Requirements

- Node.js 18+
- Network access to SAP host on port 44300 (HTTPS/ADT)
- SAP user with ADT authorizations (S_ADT_RES, S_TRANSPRT, etc.)

## Installation

```bash
git clone https://github.com/<your-org>/sap-adt-mcp.git
cd sap-adt-mcp
npm install
```

## Configuration

All connection parameters are supplied via environment variables — **no credentials are hardcoded**.

Copy `.env.example`:
```
SAP_HOST=your-s4hana-host.domain.com
SAP_CLIENT=200
SAP_USER=YOUR_USER
SAP_PASSWORD=YOUR_PASSWORD
SAP_PORT=44300   # optional, default 44300
```

### Claude Desktop Config

Add to `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac):

```json
{
  "mcpServers": {
    "sap-adt": {
      "command": "node",
      "args": ["--watch", "/path/to/sap-adt-mcp/index.js"],
      "env": {
        "SAP_HOST": "your-s4hana-host.domain.com",
        "SAP_PORT": "44300",
        "SAP_CLIENT": "200",
        "SAP_USER": "YOUR_USER",
        "SAP_PASSWORD": "YOUR_PASSWORD"
      }
    }
  }
}
```

Restart Claude desktop after saving the config. The `--watch` flag auto-reloads the server when `index.js` changes.

## Switching between Dev / QA / PRD

Just change `SAP_CLIENT` (and `SAP_HOST` if different systems) in the config env block and restart Claude desktop. No code changes needed.

## Deploying to multiple machines / accounts

The server is not tied to any specific machine or Claude account. Install Node.js, copy the folder, add the config entry with appropriate credentials, and restart Claude desktop on the target machine.

## query_sap syntax notes

The ADT Data Preview API uses a subset of SQL:
- Use standard commas between columns: `SELECT col1, col2 FROM TABLE`
- Use `max_rows` parameter instead of `LIMIT`
- `ORDER BY` is supported but `DESC` is not
- Do **not** include `MANDT` in WHERE clauses (client handling is automatic)
- An empty result set returns as 1 row with blank fields

## Troubleshooting

### Stale ENQUEUE lock (403 "User X is currently editing Y")
If the server crashes mid-operation, an SAP ENQUEUE lock may persist. Clear it via:
1. SAP GUI → transaction **SM12**
2. Filter by your SAP user
3. Find lock on table `RSDEO`, Lock Argument = `DDLS<VIEWNAME>`
4. Delete the lock entry

### CSRF / 403 errors
The server caches the CSRF token. If you get repeated 403s, restart the MCP server (restart Claude desktop) to force a fresh session.

### TLS certificate errors
SAP ADT typically uses self-signed certificates. The server disables TLS verification (`rejectUnauthorized: false`) — this is expected for on-premise SAP systems on internal networks.
