export const RECIPIENT_LINKAGE_STORAGE_KEY = "recipientLinkageCheckEnabled";

/** On by default: the check exists to warn users who do not know linkage is a risk. */
export const DEFAULT_RECIPIENT_LINKAGE_ENABLED = true;

export function resolveRecipientLinkageEnabled(value: unknown): boolean {
  return value !== false;
}

export async function getRecipientLinkageEnabled(): Promise<boolean> {
  const stored = await chrome.storage.sync.get(RECIPIENT_LINKAGE_STORAGE_KEY);
  return resolveRecipientLinkageEnabled(stored[RECIPIENT_LINKAGE_STORAGE_KEY]);
}

export async function setRecipientLinkageEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.sync.set({ [RECIPIENT_LINKAGE_STORAGE_KEY]: enabled });
}

/** Live updates so turning the setting off aborts an in-flight Send check. */
export function subscribeRecipientLinkageEnabled(listener: (enabled: boolean) => void): () => void {
  const onChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    const change = area === "sync" ? changes[RECIPIENT_LINKAGE_STORAGE_KEY] : undefined;
    if (change) listener(resolveRecipientLinkageEnabled(change.newValue));
  };
  chrome.storage.onChanged.addListener(onChanged);
  return () => chrome.storage.onChanged.removeListener(onChanged);
}
