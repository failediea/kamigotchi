// Minimal fake Yominet JSON-RPC for tests/run-tests.sh. Local only (127.0.0.1).
// It answers from a JSON config that is re-read on every request, so a test can
// change the "chain" between script runs, and logs every call as one line
// "<method> <params json>" to FAKE_RPC_LOG. It never accepts a transaction:
// eth_sendRawTransaction is not configured, so it answers with an error, and the
// tests assert that it was never even called.
//
// Config lookup order (first key present wins; a present key with value null
// answers result:null):
//   eth_call:<to>:<data>   eth_call:<to>:<4-byte selector>
//   <method>:<param0>      <method>:<param1>      <method>
// Addresses, data and hashes are lowercased.
import { createServer } from "node:http";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const configFile = process.env.FAKE_RPC_CONFIG;
const logFile = process.env.FAKE_RPC_LOG;
const portFile = process.env.FAKE_RPC_PORT_FILE;

function lookup(config, method, params) {
  const keys = [];
  if (method === "eth_call" && params?.[0]) {
    const to = String(params[0].to ?? "").toLowerCase();
    const data = String(params[0].data ?? "").toLowerCase();
    keys.push(`eth_call:${to}:${data}`, `eth_call:${to}:${data.slice(0, 10)}`);
  }
  if (params?.length > 0 && typeof params[0] !== "object") keys.push(`${method}:${String(params[0]).toLowerCase()}`);
  if (params?.length > 1 && typeof params[1] !== "object") keys.push(`${method}:${String(params[1]).toLowerCase()}`);
  keys.push(method);
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(config, key)) return { found: true, value: config[key] };
  return { found: false };
}

const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    let reply;
    try {
      const msg = JSON.parse(body);
      if (logFile) appendFileSync(logFile, `${msg.method} ${JSON.stringify(msg.params ?? [])}\n`);
      const config = JSON.parse(readFileSync(configFile, "utf8"));
      const hit = lookup(config, msg.method, msg.params ?? []);
      reply = hit.found
        ? { jsonrpc: "2.0", id: msg.id, result: hit.value }
        : { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `fake-rpc: ${msg.method} not configured` } };
    } catch (error) {
      reply = { jsonrpc: "2.0", id: null, error: { code: -32700, message: String(error.message) } };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
  });
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(portFile, String(server.address().port));
});
