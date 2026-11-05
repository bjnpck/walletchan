/**
 * Send-only recipient linkage check (Nymis Fast Linkage API). Pure model: request eligibility, strict response
 * parsing and presentation. No network, storage or logging here.
 */

/** Nymis checks the selected network plus Ethereum; these are the networks it supports today. */
export const LINKAGE_CHAIN_IDS: ReadonlySet<number> = new Set([1, 8453, 42161]);
export const LINKAGE_DEBOUNCE_MS = 400;
/** Nymis' hard stop is 11.5 s; allow headroom so a slow-but-complete answer is not discarded. */
export const LINKAGE_TIMEOUT_MS = 14_000;
export const LINKAGE_MAX_RESPONSE_BYTES = 32 * 1024;
/** Verdicts are cached for the popup session only (memory, never persisted). */
export const LINKAGE_CACHE_TTL_MS = 5 * 60_000;
/** After a 429/503 do not ask again for this long (or the server's Retry-After, if larger). */
export const LINKAGE_BACKOFF_MS = 60_000;

export type LinkageVerdict = "strong" | "weak" | "none" | "incomplete";

export interface LinkageEvidence { type: string; summary: string }
export interface RecipientLinkage {
  status: LinkageVerdict;
  /** Cautious server-supplied wording; shown only as secondary text. */
  note: string;
  evidence: LinkageEvidence[];
  chainIds: number[];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const VERDICTS: readonly string[] = ["strong", "weak", "none", "incomplete"];
const MAX_EVIDENCE = 3;
const MAX_TEXT = 300;

/** Request body, or null when no request may be made. Both addresses must already be valid and resolved. */
export function buildLinkageRequest(input: {
  fromAddress: string;
  resolvedAddress: string | null;
  chainId: number;
  ownAddresses: readonly string[];
}): { from: string; to: string; chainIds: number[] } | null {
  const { fromAddress, resolvedAddress, chainId } = input;
  if (!resolvedAddress || !ADDRESS.test(resolvedAddress) || !ADDRESS.test(fromAddress)) return null;
  if (!LINKAGE_CHAIN_IDS.has(chainId)) return null;
  const from = fromAddress.toLowerCase();
  const to = resolvedAddress.toLowerCase();
  if (from === to) return null;
  // Wallets the user holds themselves: the link is known to them, so do not disclose the pair.
  if (input.ownAddresses.some((own) => own.toLowerCase() === to)) return null;
  return { from, to, chainIds: [chainId] };
}

export function linkageCacheKey(request: { from: string; to: string; chainIds: number[] }): string {
  return `${request.from}:${request.to}:${request.chainIds.join(",")}`;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = Array.from(value, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("").trim();
  return text ? text.slice(0, MAX_TEXT) : null;
}

/** Strict parse. Anything unexpected throws, which the caller shows as inconclusive, never as a safe verdict. */
export function parseLinkageResponse(data: unknown): RecipientLinkage {
  const body = data as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || body.version !== 1) throw new Error("Unexpected linkage response");
  const status = body.status;
  if (typeof status !== "string" || !VERDICTS.includes(status)) throw new Error("Unexpected linkage status");
  const chainIds = Array.isArray(body.networksChecked)
    ? body.networksChecked.filter((id): id is number => Number.isSafeInteger(id)) : [];
  const evidence: LinkageEvidence[] = [];
  if (Array.isArray(body.results)) {
    for (const result of body.results as Array<Record<string, unknown>>) {
      if (!result || !Array.isArray(result.evidence)) continue;
      for (const item of result.evidence as Array<Record<string, unknown>>) {
        const summary = cleanText(item?.summary);
        const type = cleanText(item?.type);
        if (summary && type && evidence.length < MAX_EVIDENCE && !evidence.some((e) => e.summary === summary)) {
          evidence.push({ type, summary });
        }
      }
    }
  }
  return { status: status as LinkageVerdict, note: cleanText(body.note) ?? "", evidence, chainIds };
}

/** The server reports `none` only when every checked network is complete; `incomplete` never reads as safe. */
export type LinkagePresentation =
  | { tone: "warning"; title: string; detail: string; advice: string[] }
  | { tone: "neutral"; title: string; detail: string };

export function presentLinkage(linkage: RecipientLinkage): LinkagePresentation {
  switch (linkage.status) {
    case "strong":
      return { tone: "warning", title: "Linked wallets",
        detail: "Sending here may connect this wallet to the recipient on-chain.",
        advice: ["Sending directly will strengthen the link.", "Consider shield and send instead."] };
    case "weak":
      return { tone: "warning", title: "Possible link",
        detail: "Some on-chain activity connects these wallets. This is not proof of common ownership.", advice: [] };
    case "none":
      return { tone: "neutral", title: "No direct linkage detected",
        detail: "This does not guarantee privacy." };
    case "incomplete":
      return { tone: "neutral", title: "Linkage check inconclusive",
        detail: "Not every network could be checked. This is not a safe result." };
  }
}

/** Seconds from a Retry-After header, clamped; falls back to the default back-off. */
export function backoffMs(retryAfter: string | null): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(LINKAGE_BACKOFF_MS, Math.min(seconds, 600) * 1000) : LINKAGE_BACKOFF_MS;
}
