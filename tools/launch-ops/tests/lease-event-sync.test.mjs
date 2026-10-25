import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EVENT_SYNC_URL, readToken, syncEvents } from "../indexer/lease-event-sync.mjs";

const fakeToken = "test-only-" + "x".repeat(32);
const goodBody = { ok: true, hubs: 2, scannedBlocks: 42, inserted: 3, caughtUp: false };

test("calls only the fixed HTTPS endpoint, forbids redirects, and whitelists output", async () => {
  const out = await syncEvents({ token: fakeToken, fetchRequest: async (url, options) => {
    assert.equal(url, EVENT_SYNC_URL);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, `Bearer ${fakeToken}`);
    assert.equal(options.signal instanceof AbortSignal, true);
    return Response.json({ ...goodBody, secret: "must-not-be-output" });
  } });
  assert.deepEqual(out, { hubs: 2, scannedBlocks: 42, inserted: 3, caughtUp: false });
});

test("HTTP and application errors fail closed without echoing the remote body", async () => {
  await assert.rejects(syncEvents({ token: fakeToken, fetchRequest: async () => new Response(fakeToken, { status: 503 }) }), /^Error: HTTP_503$/);
  await assert.rejects(syncEvents({ token: fakeToken, fetchRequest: async () => Response.json({ ...goodBody, ok: false }) }), /INVALID_RESPONSE/);
  await assert.rejects(syncEvents({ token: fakeToken, fetchRequest: async () => Response.json({ ...goodBody, inserted: "3" }) }), /INVALID_RESPONSE/);
  await assert.rejects(syncEvents({ token: fakeToken, fetchRequest: async () => new Response("x".repeat(65_537)) }), /RESPONSE_TOO_LARGE/);
});

test("credentials must be a private, owned regular file; default mode sends nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "lease-sync-test-"));
  try {
    const path = join(dir, "token");
    writeFileSync(path, fakeToken, { mode: 0o600 });
    assert.equal(readToken(path), fakeToken);
    chmodSync(path, 0o644);
    assert.throws(() => readToken(path), /TOKEN_FILE_UNSAFE/);
    chmodSync(path, 0o600);
    const link = join(dir, "link");
    symlinkSync(path, link);
    assert.throws(() => readToken(link));
    writeFileSync(path, "bad\nheader: injection");
    assert.throws(() => readToken(path), /TOKEN_FORMAT/);
    const script = fileURLToPath(new URL("../indexer/lease-event-sync.mjs", import.meta.url));
    const out = execFileSync(process.execPath, [script], { encoding: "utf8", env: {} });
    assert.match(out, /DRY RUN.*no request sent/);
    assert.doesNotMatch(out, new RegExp(fakeToken));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
