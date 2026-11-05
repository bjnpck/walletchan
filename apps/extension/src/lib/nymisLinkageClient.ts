import { fetchTextBounded } from "@/chrome/network/boundedHttp";
import { NYMIS_FAST_LINKAGE_API } from "@/constants/externalUrls";
import {
  LINKAGE_MAX_RESPONSE_BYTES,
  LINKAGE_TIMEOUT_MS,
  backoffMs,
  parseLinkageResponse,
  type RecipientLinkage,
} from "@/components/Transfer/model/recipientLinkage";

/** Thrown for 429/503 so callers can pause instead of retrying. */
export class LinkageBackoffError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Linkage service busy");
    this.name = "LinkageBackoffError";
  }
}

/**
 * Sends exactly {from,to,chainIds} to Nymis. No cookies, referrer, API key or extra headers (see fetchTextBounded);
 * the pair is never logged or stored by the extension.
 */
export async function requestRecipientLinkage(
  request: { from: string; to: string; chainIds: number[] },
  signal: AbortSignal,
): Promise<RecipientLinkage> {
  const { response, text } = await fetchTextBounded(
    NYMIS_FAST_LINKAGE_API,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: request.from, to: request.to, chainIds: request.chainIds }),
      signal,
    },
    { timeoutMs: LINKAGE_TIMEOUT_MS, maxBytes: LINKAGE_MAX_RESPONSE_BYTES },
  );
  if (response.status === 429 || response.status === 503) {
    throw new LinkageBackoffError(backoffMs(response.headers.get("retry-after")));
  }
  if (!response.ok) throw new Error(`Linkage check failed (${response.status})`);
  return parseLinkageResponse(JSON.parse(text));
}
