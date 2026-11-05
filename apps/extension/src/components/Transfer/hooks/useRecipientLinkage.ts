import { useEffect, useMemo, useState } from "react";
import {
  getRecipientLinkageEnabled,
  setRecipientLinkageEnabled,
  subscribeRecipientLinkageEnabled,
} from "@/lib/recipientLinkagePreference";
import { LinkageBackoffError, requestRecipientLinkage } from "@/lib/nymisLinkageClient";
import {
  LINKAGE_CACHE_TTL_MS,
  LINKAGE_DEBOUNCE_MS,
  buildLinkageRequest,
  linkageCacheKey,
  type RecipientLinkage,
} from "../model/recipientLinkage";

type LinkageState =
  | { key: string; status: "checking" }
  | { key: string; status: "ready"; linkage: RecipientLinkage }
  | { key: string; status: "unavailable" };

// Popup-session memory only: never persisted, and cleared when the popup closes.
const cache = new Map<string, { at: number; linkage: RecipientLinkage }>();
let pausedUntil = 0;

/**
 * Send only, automatic. Queries Nymis in the background once the recipient is valid and resolved, after a debounce,
 * and never gates sending. Stale checks are aborted; the pair is never logged or persisted.
 */
export function useRecipientLinkage(options: {
  fromAddress: string;
  resolvedAddress: string | null;
  chainId: number;
  ownAddresses: readonly string[];
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeRecipientLinkageEnabled((next) => { if (active) setEnabled(next); });
    void getRecipientLinkageEnabled().then((stored) => { if (active) setEnabled((current) => current ?? stored); })
      .catch(() => { if (active) setEnabled(false); }); // unreadable setting: fail closed, send nothing
    return () => { active = false; unsubscribe(); };
  }, []);

  const ownKey = options.ownAddresses.join(",");
  const request = useMemo(
    () => (enabled ? buildLinkageRequest(options) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ownKey stands in for the array identity
    [enabled, options.fromAddress, options.resolvedAddress, options.chainId, ownKey],
  );
  const key = request ? linkageCacheKey(request) : "";
  const [state, setState] = useState<LinkageState | null>(null);

  useEffect(() => {
    if (!request || !key) return;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < LINKAGE_CACHE_TTL_MS) {
      setState({ key, status: "ready", linkage: cached.linkage });
      return;
    }
    if (Date.now() < pausedUntil) { setState({ key, status: "unavailable" }); return; }
    setState({ key, status: "checking" });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      requestRecipientLinkage(request, controller.signal)
        .then((linkage) => {
          cache.set(key, { at: Date.now(), linkage });
          if (!controller.signal.aborted) setState({ key, status: "ready", linkage });
        })
        .catch((error) => {
          if (error instanceof LinkageBackoffError) pausedUntil = Date.now() + error.retryAfterMs;
          if (!controller.signal.aborted) setState({ key, status: "unavailable" });
        });
    }, LINKAGE_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, request]);

  if (!request) return null;
  return {
    request,
    state: state && state.key === key ? state : ({ key, status: "checking" } as const),
    turnOff: () => { setEnabled(false); void setRecipientLinkageEnabled(false).catch(() => {}); },
  };
}

export type RecipientLinkageCheck = NonNullable<ReturnType<typeof useRecipientLinkage>>;
