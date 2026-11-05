import { useEffect, useState } from "react";
import { Spacer, Spinner, Switch, Text, VStack } from "@chakra-ui/react";
import {
  ListItem,
  ListItemContent,
  ListItemDescription,
  ListItemTitle,
  ListSurface,
} from "@/components/ui";
import {
  getRecipientLinkageEnabled,
  setRecipientLinkageEnabled,
  subscribeRecipientLinkageEnabled,
} from "@/lib/recipientLinkagePreference";

/** Security → Recipient link check. On by default; applies to Send only. */
export function RecipientLinkageToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeRecipientLinkageEnabled((next) => { if (active) setEnabled(next); });
    void getRecipientLinkageEnabled().then((stored) => { if (active) setEnabled((current) => current ?? stored); });
    return () => { active = false; unsubscribe(); };
  }, []);

  const toggle = async () => {
    if (enabled === null || pending) return;
    const previous = enabled;
    setEnabled(!previous);
    setPending(true);
    try {
      await setRecipientLinkageEnabled(!previous);
    } catch {
      setEnabled(previous);
    } finally {
      setPending(false);
    }
  };

  return (
    <VStack align="stretch" spacing={2}>
      <ListSurface aria-label="Recipient link check preference">
        <ListItem>
          <ListItemContent>
            <ListItemTitle>Recipient link check</ListItemTitle>
            <ListItemDescription>
              Warn before sending if the recipient is linked to this wallet on-chain.
            </ListItemDescription>
          </ListItemContent>
          <Spacer />
          {enabled === null ? (
            <Spinner size="sm" />
          ) : (
            <Switch
              aria-label="Check recipients for on-chain links to this wallet"
              isChecked={enabled}
              isDisabled={pending}
              onChange={() => void toggle()}
            />
          )}
        </ListItem>
      </ListSurface>
      <Text fontSize="xs" color="fg.secondary" lineHeight="1.5">
        When on, WalletChan sends your sending address and the recipient address to Nymis (nymis.io) once a
        recipient is entered on Ethereum, Base or Arbitrum. Nymis returns whether the two wallets show on-chain
        links. Nothing is sent for your own accounts, and sending is never delayed. WalletChan does not store or
        log the pair. Nymis’ policy applies to its handling of the request.
      </Text>
    </VStack>
  );
}
