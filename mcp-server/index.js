import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import https from "https";

// ─── CONFIG (all required via environment variables) ────────────────────────
const SAP_HOST     = process.env.SAP_HOST;
const SAP_PORT     = process.env.SAP_PORT     || "44300";
const SAP_CLIENT   = process.env.SAP_CLIENT;
const SAP_USER     = process.env.SAP_USER;
const SAP_PASSWORD = process.env.SAP_PASSWORD;

// Fail fast if required vars are missing
const missing = ["SAP_HOST", "SAP_CLIENT", "SAP_USER", "SAP_PASSWORD"].filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`ERROR: Missing required environment variables: ${missing.join(", ")}`);
  console.error("Set these in your Claude desktop config (env block) or as system environment variables.");
  console.error("See .env.example for reference.");
  process.exit(1);
}

const BASE_URL = `https://${SAP_HOST}:${SAP_PORT}`;
const TR_TARGET = `${SAP_HOST.split(".")[0].toUpperCase()}CLNT${SAP_CLIENT}`;

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const sap = axios.create({
  baseURL: BASE_URL,
  httpsAgent,
  auth: { username: SAP_USER, password: SAP_PASSWORD },
  headers: {
    "sap-client": SAP_CLIENT,
    "Accept": "application/xml, text/plain, */*"
  },
  timeout: 60000,
  withCredentials: true
});

// ─── SESSION: CSRF token + cookies cached ──────────────────────────────────
let csrfToken = null;
let sessionCookies = "";
let sessionInitialized = false;

async function initSession() {
  if (sessionInitialized && csrfToken) return csrfToken;
  const res = await sap.get("/sap/bc/adt/discovery", {
    headers: { "x-csrf-token": "Fetch" }
  });
  csrfToken = res.headers["x-csrf-token"];
  const setCookie = res.headers["set-cookie"];
  if (setCookie) sessionCookies = setCookie.map(c => c.split(";")[0]).join("; ");
  sessionInitialized = true;
  console.error("Session initialized, CSRF token:", csrfToken ? "obtained" : "missing");
  return csrfToken;
}

function invalidateSession() {
  csrfToken = null;
  sessionCookies = "";
  sessionInitialized = false;
}

// ─── HELPER: fetch ABAP source via ADT ────────────────────────────────────
async function fetchAbapSource(type, name) {
  const paths = {
    include:  `/sap/bc/adt/programs/includes/${name}/source/main`,
    program:  `/sap/bc/adt/programs/programs/${name}/source/main`,
    function: `/sap/bc/adt/functions/groups/-/functionmodules/${name}/source/main`,
    class:    `/sap/bc/adt/oo/classes/${name}/source/main`,
    cds:      `/sap/bc/adt/ddic/ddl/sources/${name}/source/main`,
  };
  const path = paths[type] || paths.include;
  const res = await sap.get(path, { headers: { "Accept": "text/plain" } });
  return res.data;
}

// ─── HELPER: run freestyle SQL via ADT Data Preview ───────────────────────
async function runSql(sql, rowCount = 200) {
  const token = await initSession();
  const res = await sap.post(
    `/sap/bc/adt/datapreview/freestyle?rowNumber=${rowCount}`,
    sql,
    {
      headers: {
        "Content-Type": "application/sql",
        "Accept": "application/vnd.sap.adt.datapreview.table.v1+xml",
        "x-csrf-token": token,
        "Cookie": sessionCookies
      }
    }
  );
  return parseAdtTableXml(res.data);
}

// ─── HELPER: parse ADT column-oriented XML table response ─────────────────
function parseAdtTableXml(xml) {
  if (typeof xml !== "string") {
    try { xml = JSON.stringify(xml); } catch(_) { return []; }
  }
  const colBlockRe = /<dataPreview:columns>([\s\S]*?)<\/dataPreview:columns>/g;
  const colBlocks = [...xml.matchAll(colBlockRe)];
  if (colBlocks.length === 0) {
    return xml.length < 8000 ? xml : xml.substring(0, 8000) + "\n... (truncated)";
  }
  const columns = [];
  for (const block of colBlocks) {
    const inner = block[1];
    const nameMatch = inner.match(/dataPreview:name="([^"]+)"/);
    const colName = nameMatch ? nameMatch[1] : `col${columns.length}`;
    const allDataRe = /<dataPreview:data[^>]*\/>|<dataPreview:data[^>]*>[\s\S]*?<\/dataPreview:data>/g;
    const allVals = [...inner.matchAll(allDataRe)].map(m => {
      const raw = m[0];
      if (raw.endsWith("/>")) return "";
      const v = raw.match(/<dataPreview:data[^>]*>([\s\S]*?)<\/dataPreview:data>/);
      return v ? v[1].trim() : "";
    });
    columns.push({ name: colName, values: allVals });
  }
  const rowCount = columns.reduce((max, c) => Math.max(max, c.values.length), 0);
  if (rowCount === 0) return [];
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const row = {};
    for (const col of columns) { row[col.name] = i < col.values.length ? col.values[i] : ""; }
    rows.push(row);
  }
  return rows;
}

// ─── HELPER: create a new Workbench Transport Request ─────────────────────
async function createTransportRequest(description) {
  const token = await initSession();
  const xml = `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:category="Workbench" tm:target="${TR_TARGET}" tm:desc="${description}"/>`;
  const res = await sap.post(
    `/sap/bc/adt/cts/transportrequests`,
    xml,
    {
      headers: {
        "Content-Type": "application/vnd.sap.adt.cts.workbench.request.v1+xml",
        "x-csrf-token": token,
        "Cookie": sessionCookies
      }
    }
  );
  const location = res.headers["location"] || "";
  const sysId = SAP_HOST.split(".")[0].toUpperCase().substring(0, 3);
  const trMatch = location.match(new RegExp(`${sysId}K\\d+`)) ||
                  (typeof res.data === "string" ? res.data.match(new RegExp(`${sysId}K\\d+`)) : null);
  const trNumber = trMatch ? trMatch[0] : null;
  const rawResponse = typeof res.data === "string" ? res.data.substring(0, 1000) : JSON.stringify(res.data).substring(0, 1000);
  return { trNumber, location, rawResponse };
}

// ─── HELPER: create or update a CDS DDL source via ADT ───────────────────
async function createOrUpdateCds(viewName, packageName, transportNumber, sourceCode) {
  const token = await initSession();
  const objectUrl = `/sap/bc/adt/ddic/ddl/sources/${viewName.toUpperCase()}`;

  // 1. Check existence
  let exists = false;
  try {
    await sap.get(objectUrl, {
      headers: { "Accept": "application/vnd.sap.adt.ddlSource+xml, application/xml, */*", "Cookie": sessionCookies }
    });
    exists = true;
    console.error("Object exists, will update");
  } catch (e) {
    if (e.response?.status === 404) {
      exists = false;
      console.error("Object does not exist, will create");
    } else {
      throw new Error("Existence check failed " + e.response?.status + ": " + JSON.stringify(e.response?.data || "").substring(0, 500));
    }
  }

  // 2. Create skeleton if new
  if (!exists) {
    const trParam = transportNumber ? `?corrNr=${transportNumber}` : "";
    const createXml = `<?xml version="1.0" encoding="utf-8"?>
<ddlsource:ddlSource xmlns:ddlsource="http://www.sap.com/adt/ddic/ddl/sources"
  xmlns:adtcore="http://www.sap.com/adt/core"
  adtcore:description="${viewName} - CDS View"
  adtcore:language="EN"
  adtcore:name="${viewName.toUpperCase()}"
  adtcore:masterLanguage="EN"
  adtcore:responsible="${SAP_USER}">
  <adtcore:packageRef adtcore:name="${packageName.toUpperCase()}"/>
</ddlsource:ddlSource>`;
    console.error("Step 2: creating skeleton");
    try {
      await sap.post(`/sap/bc/adt/ddic/ddl/sources${trParam}`, createXml, {
        headers: { "Content-Type": "application/vnd.sap.adt.ddlSource+xml", "x-csrf-token": token, "Cookie": sessionCookies }
      });
    } catch(createErr) {
      throw new Error("CREATE skeleton failed " + createErr.response?.status + ": " + JSON.stringify(createErr.response?.data || "").substring(0, 800));
    }
  }

  // 3. Acquire stateful session for LOCK
  console.error("Step 3: acquiring stateful session for LOCK");
  let statefulCookies = sessionCookies;
  let statefulToken = token;
  try {
    const stRes = await sap.get("/sap/bc/adt/discovery", {
      headers: { "x-csrf-token": "Fetch", "X-sap-adt-sessiontype": "stateful" }
    });
    if (stRes.headers["x-csrf-token"]) statefulToken = stRes.headers["x-csrf-token"];
    const sc = stRes.headers["set-cookie"];
    if (sc) statefulCookies = sc.map(c => c.split(";")[0]).join("; ");
  } catch(e) { console.error("Stateful session setup failed:", e.message); }

  // 4. LOCK — must use correct Accept header (discovered from abap-adt-api)
  console.error("Step 4: LOCK", objectUrl);
  let lockRes;
  try {
    lockRes = await new Promise((resolve, reject) => {
      const lockUrl = new URL(`${objectUrl}?_action=LOCK&accessMode=MODIFY`, BASE_URL);
      const auth = Buffer.from(`${SAP_USER}:${SAP_PASSWORD}`).toString("base64");
      const opts = {
        hostname: lockUrl.hostname,
        port: lockUrl.port || 443,
        path: lockUrl.pathname + lockUrl.search,
        method: "POST",
        headers: {
          "Authorization": `Basic ${auth}`,
          "sap-client": SAP_CLIENT,
          "x-csrf-token": statefulToken,
          "Cookie": statefulCookies,
          "X-sap-adt-sessiontype": "stateful",
          "Accept": "application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result",
          "Content-Length": "0"
        },
        rejectUnauthorized: false
      };
      const req = https.request(opts, res => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          console.error("LOCK status:", res.statusCode);
          if (res.statusCode >= 400) {
            const e = new Error("LOCK HTTP " + res.statusCode);
            e.response = { status: res.statusCode, data };
            reject(e);
          } else resolve({ data, headers: res.headers });
        });
      });
      req.on("error", reject);
      req.end();
    });
  } catch(lockErr) {
    throw new Error("LOCK failed " + lockErr.response?.status + ": " + (lockErr.response?.data || lockErr.message).toString().substring(0, 800));
  }

  const lockXml = typeof lockRes.data === "string" ? lockRes.data : JSON.stringify(lockRes.data);
  const lockMatch = lockXml.match(/<DATA>([^<]+)<\/DATA>/) ||
                    lockXml.match(/<DATA[^>]*>([^<]{20,})<\/DATA>/) ||
                    lockXml.match(/>([A-Za-z0-9+/=]{20,})</);
  const lockHandle = lockMatch ? lockMatch[1].trim() : null;
  if (!lockHandle) throw new Error("Could not obtain lock handle. Response: " + lockXml.substring(0, 800));
  console.error("Lock handle obtained:", lockHandle.substring(0, 20) + "...");

  // 5. PUT source code
  console.error("Step 5: PUT source");
  try {
    await sap.put(
      `${objectUrl}/source/main?lockHandle=${encodeURIComponent(lockHandle)}`,
      sourceCode,
      {
        headers: {
          "Content-Type": "text/plain",
          "x-csrf-token": statefulToken,
          "Cookie": statefulCookies
        }
      }
    );
  } catch(putErr) {
    throw new Error("PUT failed " + putErr.response?.status + ": " + JSON.stringify(putErr.response?.data || "").substring(0, 800));
  }

  // 6. UNLOCK (same stateful session; wrapped in try/catch — failure leaves stale lock, clear via SM12)
  console.error("Step 6: UNLOCK");
  try {
    await sap.delete(
      `${objectUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`,
      {
        headers: {
          "x-csrf-token": statefulToken,
          "Cookie": statefulCookies,
          "X-sap-adt-sessiontype": "stateful"
        }
      }
    );
    console.error("Unlock successful");
  } catch(unlockErr) {
    console.error("Unlock warning (clear via SM12 if needed):", unlockErr.response?.status, unlockErr.message);
  }

  return `${exists ? "Updated" : "Created"} ${viewName.toUpperCase()} successfully in package ${packageName} / TR ${transportNumber || "auto"}.`;
}

// ─── HELPER: activate a CDS object ───────────────────────────────────────
async function activateObject(viewName) {
  const token = await initSession();
  const adtUrl = `/sap/bc/adt/ddic/ddl/sources/${viewName.toUpperCase()}`;
  const activateXml = `<?xml version="1.0" encoding="utf-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReference adtcore:adtObjectType="DDLS" adtcore:name="${viewName.toUpperCase()}" adtcore:uri="${adtUrl}"/>
</adtcore:objectReferences>`;
  const res = await sap.post(
    `/sap/bc/adt/activation?method=activate&preauditRequested=true`,
    activateXml,
    {
      headers: {
        "Content-Type": "application/vnd.sap.adt.activation.request.v1+xml",
        "Accept": "application/vnd.sap.adt.activation.result.v1+xml, application/xml",
        "x-csrf-token": token,
        "Cookie": sessionCookies
      }
    }
  );
  const resp = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  return resp.length < 3000 ? resp : resp.substring(0, 3000) + "\n...(truncated)";
}

// ─── MCP SERVER ────────────────────────────────────────────────────────────
const server = new McpServer({ name: "sap-adt-mcp", version: "2.0.0" });

// ── TOOL 1: Read ABAP source ──────────────────────────────────────────────
server.tool(
  "read_abap_source",
  "Read ABAP source code from S/4HANA via ADT.",
  {
    type: z.enum(["include", "program", "function", "class", "cds"]),
    name: z.string()
  },
  async ({ type, name }) => {
    try {
      const source = await fetchAbapSource(type, name.toUpperCase());
      return { content: [{ type: "text", text: `=== ${type.toUpperCase()}: ${name.toUpperCase()} ===\n\n${source}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR reading ${name}: ${err.response?.status} ${err.response?.statusText || err.message}\n${JSON.stringify(err.response?.data || "")}` }] };
    }
  }
);

// ── TOOL 2: Query SAP table/view ─────────────────────────────────────────
server.tool(
  "query_sap",
  "Run a SQL query against S/4HANA via ADT Data Preview. Use standard SQL syntax with commas. Do not use LIMIT or ORDER BY DESC. Do not filter on MANDT. Use max_rows to limit results.",
  {
    sql: z.string(),
    max_rows: z.number().optional().default(500)
  },
  async ({ sql, max_rows }) => {
    try {
      const result = await runSql(sql, max_rows);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text: `Query Results (${Array.isArray(result) ? result.length : "?"} rows):\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.response?.status} ${err.response?.statusText || err.message}\n${JSON.stringify(err.response?.data || "")}` }] };
    }
  }
);

// ── TOOL 3: Search ABAP objects ───────────────────────────────────────────
server.tool(
  "search_abap_objects",
  "Search for ABAP objects by name pattern.",
  { query: z.string(), type: z.string().optional() },
  async ({ query, type }) => {
    try {
      const typeParam = type ? `&objectType=${type}` : "";
      const res = await sap.get(
        `/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(query)}${typeParam}&maxResults=50`
      );
      return { content: [{ type: "text", text: res.data }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.response?.status} ${err.message}\n${err.response?.data || ""}` }] };
    }
  }
);

// ── TOOL 4: Get MB5B equivalent data ─────────────────────────────────────
server.tool(
  "get_mb5b_equivalent",
  "Query MATDOC for stock movements (MB5B equivalent) from S/4HANA.",
  {
    material: z.string().optional(),
    plant: z.string().optional(),
    start_date: z.string().describe("YYYYMMDD"),
    end_date: z.string().describe("YYYYMMDD"),
    max_rows: z.number().optional().default(200)
  },
  async ({ material, plant, start_date, end_date, max_rows }) => {
    try {
      const matFilter   = material ? `AND MATNR = '${material.padStart(18, "0")}'` : "";
      const plantFilter = plant    ? `AND WERKS = '${plant}'` : "";
      const sql = `SELECT MATNR, WERKS, LGORT, BWART, SHKZG, MENGE, MEINS, BUDAT FROM MATDOC WHERE BUDAT BETWEEN '${start_date}' AND '${end_date}' AND SOBKZ = '' ${matFilter} ${plantFilter}`.replace(/\s+/g, " ").trim();
      const result = await runSql(sql, max_rows);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text: `MB5B-equivalent (${Array.isArray(result) ? result.length : "?"} rows):\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}\n${JSON.stringify(err.response?.data || "")}` }] };
    }
  }
);

// ── TOOL 5: Read movement type config ─────────────────────────────────────
server.tool(
  "get_movement_type_config",
  "Read T156S — movement type sign/quantity control table used by MB5B.",
  { movement_type: z.string().optional() },
  async ({ movement_type }) => {
    try {
      const filter = movement_type ? `WHERE BWART = '${movement_type}'` : "";
      const sql = `SELECT BWART, KZZUG FROM T156S ${filter}`.replace(/\s+/g, " ").trim();
      const result = await runSql(sql, 500);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text: `T156S Movement Type Config:\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}\n${JSON.stringify(err.response?.data || "")}` }] };
    }
  }
);

// ── TOOL 6: Create a Workbench Transport Request ──────────────────────────
server.tool(
  "create_transport_request",
  "Create a new Workbench Transport Request in S/4HANA via ADT.",
  {
    description: z.string().describe("Short description for the TR")
  },
  async ({ description }) => {
    try {
      const result = await createTransportRequest(description);
      return { content: [{ type: "text", text: `Transport Request Created:\nTR Number: ${result.trNumber || "unknown — check raw response"}\nLocation: ${result.location}\nRaw: ${result.rawResponse}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR creating TR: ${err.response?.status} ${err.response?.statusText || err.message}\n${JSON.stringify(err.response?.data || "").substring(0, 1000)}` }] };
    }
  }
);

// ── TOOL 7: Create or update a CDS DDL source ────────────────────────────
server.tool(
  "create_cds_view",
  "Create or update a CDS DDL source object in S/4HANA via ADT REST API.",
  {
    view_name: z.string().describe("CDS view name, e.g. ZBV_MM_STOCK_RANGE"),
    package_name: z.string().describe("Package name, e.g. ZSAC_REPORTS"),
    transport_number: z.string().optional().describe("TR number, e.g. RD1K908500"),
    source_code: z.string().describe("Full CDS DDL source code")
  },
  async ({ view_name, package_name, transport_number, source_code }) => {
    try {
      const result = await createOrUpdateCds(view_name, package_name, transport_number, source_code);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data).substring(0, 1000) : err.message;
      return { content: [{ type: "text", text: `ERROR: ${err.response?.status} ${err.response?.statusText || err.message}\n${detail}` }] };
    }
  }
);

// ── TOOL 8: Activate a CDS object ────────────────────────────────────────
server.tool(
  "activate_cds_view",
  "Activate a CDS DDL source object in S/4HANA via ADT.",
  {
    view_name: z.string().describe("CDS view name to activate")
  },
  async ({ view_name }) => {
    try {
      const result = await activateObject(view_name);
      return { content: [{ type: "text", text: `Activation result for ${view_name.toUpperCase()}:\n\n${result}` }] };
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data).substring(0, 1000) : err.message;
      return { content: [{ type: "text", text: `ERROR activating ${view_name}: ${err.response?.status} ${err.response?.statusText || err.message}\n${detail}` }] };
    }
  }
);

// ─── START ─────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`SAP ADT MCP Server v2.0.0 running — ${SAP_USER}@${BASE_URL} client ${SAP_CLIENT}`);
