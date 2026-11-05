/**
 * Run against `pnpm dev:preview`. Synthetic preview state; nymis.io is intercepted (no real request leaves the page),
 * nothing is signed or broadcast. Set LINKAGE_QA_OUT to keep screenshots.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const base = process.env.PREVIEW_URL || "http://localhost:4317";
const output = process.env.LINKAGE_QA_OUT || (await mkdtemp(path.join(os.tmpdir(), "walletchan-linkage-")));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" });
const A = "0x2222222222222222222222222222222222222222"; // strong
const B = "0x3333333333333333333333333333333333333333"; // weak
const C = "0x4444444444444444444444444444444444444444"; // none
const D = "0x5555555555555555555555555555555555555555"; // incomplete
const E = "0x6666666666666666666666666666666666666666"; // http 500
const F = "0x7777777777777777777777777777777777777777"; // slow
const OWN = "0x8888888888888888888888888888888888888888"; // one of the user's accounts
const body = (status, evidence = []) => ({
  version: 1, status, note: "n", networksChecked: [8453, 1],
  supportingChainIds: status === "strong" || status === "weak" ? [1] : [],
  results: [{ chainId: 1, status, coverage: status === "incomplete" ? "incomplete" : "complete", evidence }],
});
const replies = {
  [A]: body("strong", [{ type: "repeated-bidirectional-transfer", summary: "12 transfers in both directions between these wallets (Jan 2025 – Oct 2026)." }]),
  [B]: body("weak", [{ type: "direct-transfer", summary: "1 ETH transfer between these wallets on Ethereum." }]),
  [C]: body("none"),
  [D]: body("incomplete"),
};

async function openSend({ theme = "midnight", chainId = 8453, syncEnabled, accounts = "[]" } = {}) {
  const page = await browser.newPage({ viewport: { width: 360, height: 760 } });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => console.error(`pageerror: ${error.message}`));
  // The preview blocks live fetches by design, so stub the Nymis URL in-page (after installPreviewChrome).
  const requests = new Proxy([], { get: (_t, key) => key === "length" ? pageRequests() : undefined });
  const pageRequests = () => pendingCount;
  let pendingCount = 0;
  page.on("console", (m) => { if (m.text().startsWith("LINKAGE_REQ")) pendingCount++; });
  await page.route("**/src/preview/index.tsx*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOMClient from '/node_modules/.vite/deps/react-dom_client.js';
      import { ThemeProvider, SELECTED_THEME_STORAGE_KEY } from '/src/theme/index.ts';
      import { NetworksProvider } from '/src/contexts/NetworksContext.tsx';
      import { installPreviewChrome } from '/src/preview/previewChrome.ts';
      import { getPreviewWallet } from '/src/preview/fixtures.ts';
      import { previewPortfolioResponse } from '/src/preview/previewEnvironment.ts';
      import TokenTransfer from '/src/components/Transfer/TokenTransfer.tsx';
      import '/src/index.css';
      import '/src/preview/preview.css';
      installPreviewChrome();
      const previewFetch = window.fetch.bind(window);
      const replies = ${JSON.stringify(replies)};
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url !== 'https://nymis.io/api/v1/fast-linkage') return previewFetch(input, init);
        const payload = JSON.parse(init.body);
        window.__linkageRequests = [...(window.__linkageRequests ?? []), { ...payload, init: { credentials: init.credentials, referrerPolicy: init.referrerPolicy, redirect: init.redirect, headers: init.headers, keys: Object.keys(payload).sort() } }];
        console.log('LINKAGE_REQ');
        if (payload.to === '${E}') return new Response('boom', { status: 500 });
        if (payload.to === '${F}') await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 1500);
          init.signal.addEventListener('abort', () => { clearTimeout(t); window.__linkageAborted = (window.__linkageAborted ?? 0) + 1; reject(init.signal.reason); });
        });
        return Response.json(replies[payload.to] ?? ${JSON.stringify(body("none"))});
      };
      localStorage.setItem(SELECTED_THEME_STORAGE_KEY, '${theme}');
      await chrome.storage.local.set({ [SELECTED_THEME_STORAGE_KEY]: '${theme}' });
      ${syncEnabled === false ? "await chrome.storage.sync.set({ recipientLinkageCheckEnabled: false });" : ""}
      document.body.classList.add('preview-canvas');
      const account = getPreviewWallet('privateKey');
      ReactDOMClient.createRoot(document.getElementById('preview-root')).render(
        React.createElement(ThemeProvider, null,
          React.createElement(NetworksProvider, null,
            React.createElement(TokenTransfer, { token: { ...previewPortfolioResponse.tokens[1], chainId: ${chainId} },
              fromAddress: account.address, chainId: ${chainId}, accountType: 'privateKey',
              accounts: ${accounts}, onBack() {}, onTransferInitiated() {} }))));
    `,
  }));
  await page.route("**/src/hooks/useAddressResolver.ts*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `export function useAddressResolver(input) {
      const address = input === 'slowens.eth' ? null : /^0x[0-9a-f]{40}$/i.test(input) ? input : null;
      return {resolvedAddress: address, resolvedName: null, avatar: null,
        isValid: !!address, isResolving: input === 'slowens.eth', isLoadingExtras: false, error: null};
    }`,
  }));
  await page.goto(`${base}/preview/send?wallet=privateKey&frame=popup&theme=${theme}&canvas=1`);
  await page.locator("#send-recipient").waitFor();
  return { page, requests };
}

try {
  for (const theme of ["midnight", "bauhaus"]) {
    const { page, requests } = await openSend({ theme });
    const input = page.locator("#send-recipient");

    // Typing a partial address, then rapidly through several values, sends nothing until it settles.
    await input.pressSequentially("0x2222", { delay: 30 });
    await page.waitForTimeout(700);
    assert.equal(requests.length, 0, "no request for an incomplete address");
    await input.fill(C); await input.fill(B); await input.fill(A);
    await expect(page.getByText("Linked wallets", { exact: true })).toBeVisible();
    assert.equal(requests.length, 1, "debounce collapses rapid edits into one request");
    const sent = await page.evaluate(() => window.__linkageRequests);
    assert.deepEqual(sent[0].chainIds, [8453]);
    assert.deepEqual(sent[0].init.keys, ["chainIds", "from", "to"]);
    assert.equal(sent[0].init.credentials, "omit");
    assert.equal(sent[0].init.referrerPolicy, "no-referrer");
    assert.equal(sent[0].init.redirect, "error");
    await expect(page.getByText(/12 transfers in both directions/)).toBeVisible();
    await expect(page.getByText("Sending directly will strengthen the link. Consider shield and send instead.")).toBeVisible();
    const href = await page.getByRole("link", { name: /Explore full linkage on Nymis/ }).getAttribute("href");
    assert.match(href, /^https:\/\/nymis\.io\/address-linkage\?from=0x[0-9a-f]{40}&to=0x2222/);
    await expect(page.getByText(/shared with Nymis/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Review send/ })).toBeVisible();
    await page.screenshot({ path: path.join(output, `strong-${theme}.png`), fullPage: true });

    // Same recipient again: served from the session cache, no duplicate request.
    await input.fill(C); await expect(page.getByText(/No direct linkage detected/)).toBeVisible();
    await input.fill(A); await expect(page.getByText("Linked wallets", { exact: true })).toBeVisible();
    assert.equal(requests.length, 2, "revisiting A is cached");

    await input.fill(B);
    await expect(page.getByText("Possible link", { exact: true })).toBeVisible();
    await expect(page.getByText(/Consider shield and send instead/)).toHaveCount(0);
    await page.screenshot({ path: path.join(output, `weak-${theme}.png`), fullPage: true });

    await input.fill(C);
    await expect(page.getByText(/No direct linkage detected/)).toBeVisible();
    await expect(page.getByText(/does not guarantee privacy/)).toBeVisible();
    await page.screenshot({ path: path.join(output, `none-${theme}.png`), fullPage: true });

    await input.fill(D);
    await expect(page.getByText(/Link check inconclusive|Linkage check inconclusive/)).toBeVisible();
    await expect(page.getByText(/No direct linkage detected/)).toHaveCount(0);
    await page.screenshot({ path: path.join(output, `incomplete-${theme}.png`), fullPage: true });

    await input.fill(E);
    await expect(page.getByText(/Link check inconclusive/)).toBeVisible();
    await expect(page.getByText(/No direct linkage detected/)).toHaveCount(0);
    await page.screenshot({ path: path.join(output, `error-${theme}.png`), fullPage: true });

    // Stale check: switching away from a slow request aborts it and never shows its answer.
    const before = requests.length;
    await input.fill(F); await page.waitForTimeout(600);
    await input.fill(A);
    assert.equal(await page.evaluate(() => window.__linkageAborted), 1, "stale slow request was aborted");
    await expect(page.getByText("Linked wallets", { exact: true })).toBeVisible();
    await page.waitForTimeout(1500);
    assert.equal(requests.length, before + 1, "slow request started once");
    await expect(page.getByText(/12 transfers/)).toBeVisible();
    // 320px: no horizontal overflow, text visible.
    await page.setViewportSize({ width: 320, height: 568 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

    // A pending check only shows status; it is not wired into the Review gate.
    await input.fill(F);
    await expect(page.getByText(/Checking for on-chain links/)).toBeVisible();

    // Turn off from the notice: stops further requests.
    await input.fill(A);
    await page.getByRole("button", { name: "Turn off" }).first().click();
    await expect(page.getByText(/shared with Nymis/)).toHaveCount(0);
    const afterOff = requests.length;
    await input.fill(B); await page.waitForTimeout(900);
    assert.equal(requests.length, afterOff, "no request after turning off");
    await page.close();
    console.log(`PASS ${theme}: debounce, cache, strong/weak/none/incomplete/error, stale abort, 320px, turn off`);
  }

  // Disabled in settings from the start: nothing is ever sent.
  {
    const { page, requests } = await openSend({ syncEnabled: false });
    await page.locator("#send-recipient").fill(A);
    await page.waitForTimeout(1200);
    assert.equal(requests.length, 0);
    await expect(page.getByText(/shared with Nymis/)).toHaveCount(0);
    await page.close();
    console.log("PASS disabled: no request");
  }
  // Unsupported network (Optimism) and the user's own account: no request, no notice.
  {
    const { page, requests } = await openSend({ chainId: 10 });
    await page.locator("#send-recipient").fill(A);
    await page.waitForTimeout(1200);
    assert.equal(requests.length, 0);
    await page.close();
    console.log("PASS unsupported network: no request");
  }
  {
    const accounts = JSON.stringify([{ id: "own", type: "privateKey", address: OWN, displayName: "Mine" }]);
    const { page, requests } = await openSend({ accounts });
    await page.locator("#send-recipient").fill(OWN);
    await page.waitForTimeout(1200);
    assert.equal(requests.length, 0);
    await page.close();
    console.log("PASS own account: no request");
  }
  // Unresolved name: no request while resolving.
  {
    const { page, requests } = await openSend({});
    await page.locator("#send-recipient").fill("slowens.eth");
    await page.waitForTimeout(1200);
    assert.equal(requests.length, 0);
    await page.close();
    console.log("PASS unresolved recipient: no request");
  }
  console.log(`Screenshots: ${output}`);
} finally { await browser.close(); }
