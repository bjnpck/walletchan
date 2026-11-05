import assert from "node:assert/strict";
import test from "node:test";
import {
  LINKAGE_BACKOFF_MS,
  LINKAGE_CHAIN_IDS,
  backoffMs,
  buildLinkageRequest,
  linkageCacheKey,
  parseLinkageResponse,
  presentLinkage,
} from "../../src/components/Transfer/model/recipientLinkage";
import { LinkageBackoffError, requestRecipientLinkage } from "../../src/lib/nymisLinkageClient";
import { nymisAddressLinkageUrl } from "../../src/constants/externalUrls";
import { resolveRecipientLinkageEnabled } from "../../src/lib/recipientLinkagePreference";

const FROM = "0xB332081ef9402315869989daeaC0705B4222FADD";
const TO = "0x87376f16268a0b93055a6fbcbe94f093cb589b81";
const base = { fromAddress: FROM, resolvedAddress: TO, chainId: 1, ownAddresses: [] as string[] };

test("requests are only built for a valid, resolved, non-own recipient on supported networks", () => {
  assert.deepEqual(buildLinkageRequest(base), { from: FROM.toLowerCase(), to: TO, chainIds: [1] });
  assert.deepEqual([...LINKAGE_CHAIN_IDS].sort((a, b) => a - b), [1, 8453, 42161]);
  assert.equal(buildLinkageRequest({ ...base, chainId: 8453 })?.chainIds[0], 8453);
  assert.equal(buildLinkageRequest({ ...base, chainId: 10 }), null); // Optimism unsupported
  assert.equal(buildLinkageRequest({ ...base, resolvedAddress: null }), null); // unresolved ENS / still typing
  assert.equal(buildLinkageRequest({ ...base, resolvedAddress: "0x1234" }), null);
  assert.equal(buildLinkageRequest({ ...base, resolvedAddress: FROM }), null); // self
  assert.equal(buildLinkageRequest({ ...base, ownAddresses: [TO.toUpperCase().replace("0X", "0x")] }), null); // own account
});

test("cache key ignores address case and separates networks", () => {
  const a = buildLinkageRequest(base)!;
  const b = buildLinkageRequest({ ...base, resolvedAddress: TO.toUpperCase().replace("0X", "0x") })!;
  assert.equal(linkageCacheKey(a), linkageCacheKey(b));
  assert.notEqual(linkageCacheKey(a), linkageCacheKey({ ...a, chainIds: [8453] }));
});

const ok = (status: string, evidence: unknown[] = []) => ({
  version: 1, status, note: "n", networksChecked: [8453, 1], supportingChainIds: [],
  results: [{ chainId: 1, status, coverage: "complete", evidence }],
});

test("parsing keeps bounded, de-duplicated evidence and rejects unexpected shapes", () => {
  const ev = Array.from({ length: 6 }, (_, i) => ({ type: "direct-transfer", summary: `s${i % 4}\u0007` }));
  const parsed = parseLinkageResponse(ok("weak", ev));
  assert.equal(parsed.status, "weak");
  assert.equal(parsed.evidence.length, 3);
  assert.ok(parsed.evidence.every((e) => Array.from(e.summary).every((ch) => ch.charCodeAt(0) >= 32)));
  for (const bad of [null, {}, { ...ok("none"), version: 2 }, ok("safe"), "none"]) {
    assert.throws(() => parseLinkageResponse(bad));
  }
});

test("none is neutral and never claims privacy; incomplete is never a safe verdict", () => {
  const none = presentLinkage(parseLinkageResponse(ok("none")));
  assert.equal(none.tone, "neutral");
  assert.equal(none.title, "No direct linkage detected");
  assert.match(none.detail, /not guarantee privacy/i);
  const incomplete = presentLinkage(parseLinkageResponse(ok("incomplete")));
  assert.match(incomplete.title, /inconclusive/i);
  assert.doesNotMatch(`${incomplete.title} ${incomplete.detail}`, /no direct linkage/i);
  const strong = presentLinkage(parseLinkageResponse(ok("strong")));
  assert.equal(strong.tone, "warning");
  assert.deepEqual(strong.tone === "warning" && strong.advice,
    ["Sending directly will strengthen the link.", "Consider shield and send instead."]);
  const weak = presentLinkage(parseLinkageResponse(ok("weak")));
  assert.equal(weak.tone, "warning");
  assert.deepEqual(weak.tone === "warning" && weak.advice, []);
});

test("setting is on unless explicitly disabled", () => {
  assert.equal(resolveRecipientLinkageEnabled(undefined), true);
  assert.equal(resolveRecipientLinkageEnabled(true), true);
  assert.equal(resolveRecipientLinkageEnabled(false), false);
});

test("back-off honours Retry-After but never goes below the default", () => {
  assert.equal(backoffMs(null), LINKAGE_BACKOFF_MS);
  assert.equal(backoffMs("5"), LINKAGE_BACKOFF_MS);
  assert.equal(backoffMs("120"), 120_000);
  assert.equal(backoffMs("99999"), 600_000);
});

test("client posts exactly {from,to,chainIds} with no credentials and maps statuses", async () => {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let reply: () => Response = () => Response.json(ok("none"));
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return reply(); }) as typeof fetch;
  try {
    const request = buildLinkageRequest(base)!;
    const result = await requestRecipientLinkage(request, new AbortController().signal);
    assert.equal(result.status, "none");
    assert.equal(calls[0].url, "https://nymis.io/api/v1/fast-linkage");
    assert.deepEqual(Object.keys(JSON.parse(String(calls[0].init.body))).sort(), ["chainIds", "from", "to"]);
    assert.equal(calls[0].init.credentials, "omit");
    assert.equal(calls[0].init.referrerPolicy, "no-referrer");
    assert.equal(calls[0].init.redirect, "error");
    assert.deepEqual(Object.keys(calls[0].init.headers as object), ["Content-Type"]);

    reply = () => new Response("<html>busy</html>", { status: 503, headers: { "retry-after": "90" } });
    await assert.rejects(requestRecipientLinkage(request, new AbortController().signal),
      (e) => e instanceof LinkageBackoffError && e.retryAfterMs === 90_000);
    reply = () => Response.json({ error: "rate_limited" }, { status: 429 });
    await assert.rejects(requestRecipientLinkage(request, new AbortController().signal), LinkageBackoffError);
    reply = () => Response.json({ error: "invalid_address" }, { status: 400 });
    await assert.rejects(requestRecipientLinkage(request, new AbortController().signal), /400/);
    reply = () => new Response("not json", { status: 200 });
    await assert.rejects(requestRecipientLinkage(request, new AbortController().signal));
    reply = () => new Response("x".repeat(40_000), { status: 200 });
    await assert.rejects(requestRecipientLinkage(request, new AbortController().signal), /size|exceeded/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("full-linkage link carries only the two addresses, URL-encoded, on nymis.io", () => {
  const url = new URL(nymisAddressLinkageUrl(FROM.toLowerCase(), TO));
  assert.equal(url.origin + url.pathname, "https://nymis.io/address-linkage");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["from", "to"]);
});
