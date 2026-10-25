---
name: sap-adt-mcp-setup
description: Set up, configure, debug, and use the SAP ADT MCP server for CDS view deployment, ABAP source reads, and SAP data queries from Claude.
sources: [cowork]
---

# SAP ADT MCP Server — Setup & Usage

## What it is
A Node.js MCP server that exposes SAP ADT REST API operations as Claude tools:
- `create_cds_view` — write + activate a CDS DDL source in SAP
- `activate_cds_view` — activate an existing CDS view
- `read_abap_source` — read ABAP program/include/function/CDS source
- `query_sap` — run SQL against SAP tables/views via ADT Data Preview
- `get_mb5b_equivalent` — query MATDOC for stock movement data
- `search_abap_objects` — search repository objects
- `create_transport_request` — create a new Workbench TR
- `get_movement_type_config` — read movement type configuration

## Installation on a new machine
1. Clone the repo and `cd mcp-server && npm install`
2. Edit Claude desktop config at `%APPDATA%\Claude\claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "sap-adt": {
      "command": "node",
      "args": ["--watch", "C:\\path\\to\\sap\\mcp-server\\index.js"],
      "env": {
        "SAP_HOST": "<hostname>",
        "SAP_PORT": "44300",
        "SAP_CLIENT": "200",
        "SAP_USER": "<user>",
        "SAP_PASSWORD": "<password>"
      }
    }
  }
}
```
3. Restart Claude desktop — MCP server auto-starts
4. `--watch` flag auto-reloads index.js on file changes (no restart needed during development)

## Switching between Dev/QA/PRD
Change `SAP_CLIENT` (and `SAP_HOST` if different systems) in the config env block and restart Claude desktop. No code changes needed.

## Sharing with other machines / accounts
- Copy folder + set config on any machine with network access to the SAP host on port 44300
- Not tied to any specific Claude account — works on any Claude desktop install
- Credentials are plain text in config — use a shared/service SAP user, not personal credentials

## Critical: SAP ADT LOCK mechanism
The hardest part. Getting LOCK wrong blocks deployment entirely.

### Correct LOCK Accept header (discovered from abap-adt-api npm package):
```
Accept: application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result
```
**Wrong** (causes 406 ExceptionResourceNotAcceptable):
```
Accept: application/vnd.sap.adt.lock+xml
```

### Stateful session required for LOCK:
- Fetch a new CSRF token with `X-sap-adt-sessiontype: stateful` header before LOCK
- Use that stateful token + cookies for LOCK, PUT, and UNLOCK
- All three must use the same stateful session

### Lock handle parsing:
```javascript
// Response XML: <asx:abap><asx:values><DATA>lockHandle</DATA></asx:values></asx:abap>
const lockMatch = lockXml.match(/<DATA>([^<]+)<\/DATA>/);
const lockHandle = lockMatch ? lockMatch[1].trim() : null;
```

### UNLOCK must use stateful session:
Wrap UNLOCK in try/catch — a failed UNLOCK leaves a stale ENQUEUE lock.

### Stale ENQUEUE lock recovery (SM12):
If UNLOCK fails, an ENQUEUE lock persists. Fix:
1. SAP GUI → transaction SM12
2. Filter by SAP user, execute
3. Find lock on table `RSDEO`, Lock Argument = `DDLS<VIEWNAME>`
4. Select row → Delete

## query_sap syntax rules
- Standard SQL with commas between columns
- Use `max_rows` parameter (not LIMIT)
- No `ORDER BY ... DESC`
- No MANDT in WHERE clause
- Empty result returns as 1 row with blank fields (not a true empty indicator)

## Known project specifics (DIMO INFRA / RD1)
- SAP system: `vhfihrd1ap01.sap.bsriil.com:44300`
- Dev client: 200, QA client: 210
- SAP user: INFRA_SAC
- Transport: RD1K908760, Package: ZSAC_REPORTS
- Dev client 200 has zero transactional data — test in QA (client 210)
- MCP server on Windows: `C:\sap-adt-mcp\index.js`
