import { WarningTwoIcon } from "@chakra-ui/icons";
import { Box, Button, HStack, Link, Spinner, Text, VStack } from "@chakra-ui/react";
import { nymisAddressLinkageUrl } from "@/constants/externalUrls";
import type { RecipientLinkageCheck } from "./hooks/useRecipientLinkage";
import { presentLinkage } from "./model/recipientLinkage";

function Disclosure({ onTurnOff }: { onTurnOff: () => void }) {
  return (
    <Text fontSize="xs" color="fg.secondary" lineHeight="short">
      Your address and the recipient’s are shared with Nymis for this check.{" "}
      <Button variant="link" size="xs" onClick={onTurnOff} verticalAlign="baseline">Turn off</Button>
    </Text>
  );
}

/** Informational only: never blocks or delays sending. */
export function RecipientLinkageNotice({ check }: { check: RecipientLinkageCheck }) {
  const { state, turnOff, request } = check;
  if (state.status === "checking") return (
    <HStack role="status" mt={2} spacing={2} color="fg.secondary">
      <Spinner size="xs" /><Text fontSize="xs">Checking for on-chain links to this recipient…</Text>
    </HStack>
  );
  if (state.status === "unavailable") return (
    <VStack role="status" align="stretch" mt={2} spacing={0.5}>
      <Text fontSize="xs" color="fg.secondary">Link check inconclusive — it could not be completed. This is not a safe result.</Text>
      <Disclosure onTurnOff={turnOff} />
    </VStack>
  );
  const view = presentLinkage(state.linkage);
  if (view.tone === "neutral") return (
    <VStack role="status" align="stretch" mt={2} spacing={0.5}>
      <Text fontSize="xs" color="fg.secondary">
        <Text as="span" fontWeight="600">{view.title}.</Text> {view.detail}
      </Text>
      <Disclosure onTurnOff={turnOff} />
    </VStack>
  );
  return (
    <Box role="alert" mt={2} p={3} bg="status.warning.tint"
      borderWidth="1px" borderColor="status.warning.border" borderRadius="lg">
      <HStack align="start" spacing={2}>
        <WarningTwoIcon boxSize="14px" flexShrink={0} color="status.warning.emphasis" mt="2px" aria-hidden="true" />
        <Box flex={1} minW={0}>
          <Text fontSize="xs" fontWeight="600" lineHeight="short">{view.title}</Text>
          <Text mt={1} fontSize="xs" lineHeight="base" color="fg.secondary">{view.detail}</Text>
          {view.advice.length > 0 && (
            <Text mt={1} fontSize="xs" lineHeight="base">{view.advice.join(" ")}</Text>
          )}
          {state.linkage.evidence.length > 0 && (
            <VStack as="ul" align="stretch" spacing={1} mt={2} pl={4} listStyleType="disc">
              {state.linkage.evidence.map((item) => (
                <Text as="li" key={item.summary} fontSize="xs" lineHeight="base">{item.summary}</Text>
              ))}
            </VStack>
          )}
          <Link href={nymisAddressLinkageUrl(request.from, request.to)} isExternal display="inline-block" mt={2}
            fontSize="xs" color="fg.secondary" textDecoration="underline">
            Explore full linkage on Nymis ↗
          </Link>
          <Box mt={2}><Disclosure onTurnOff={turnOff} /></Box>
        </Box>
      </HStack>
    </Box>
  );
}
