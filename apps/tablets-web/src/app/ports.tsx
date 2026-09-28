/**
 * Port contexts (plan section 7, "Web skeleton"): the step screen (C4) calls these hooks and never imports C1 or
 * C5 code. Stub defaults refuse politely; the real providers arrive through features/access (C1: the signature
 * ceremony and the badge tap) and features/devices (C5: the scale capture slot), already wired in App.tsx.
 */
import { createContext, createElement, useContext, type ComponentType, type ReactNode } from 'react';
import type { Attribution, ManifestationView, ReadingView, RefusalEnvelope, SignableAction } from '@ebmr/api-contract';
import { Banner } from '@ebmr/ui-kit';

export interface SignRequest {
  aggregateType: string;
  aggregateId: string;
  meaning: string;
  action: SignableAction;
  /** What the dialog says is being signed, e.g. "Sign step 2.1.4 Blend as performed". */
  title: string;
}

export type SignOutcome =
  | { status: 'SIGNED'; manifestation: ManifestationView; result: Record<string, unknown> | null }
  | { status: 'CANCELLED' }
  | { status: 'REFUSED'; refusal: RefusalEnvelope }
  /** The response was lost: the dialog reloaded the signatures and found none (never re-sends credentials). */
  | { status: 'NOT_CONFIRMED' };

export interface SignatureCeremonyPort {
  sign(request: SignRequest): Promise<SignOutcome>;
}

/**
 * The exact request the tap confirms. The device proof inside the attribution covers method, path and body, and the
 * server verifies it over the body it receives minus the `attribution` member, so pass the body exactly as sent.
 */
export interface TapRequest {
  method: string;
  /** The URL path with parameters filled in, without the query string. */
  path: string;
  /** The request body exactly as sent, without `attribution`. */
  body: Record<string, unknown>;
}

export interface BadgeTapPort {
  /**
   * Asks for a badge tap of the signed-in person and returns the attribution for `request` (a fresh device proof over
   * it); null when cancelled or timed out. A resend asks again with the same request (a proof is single use).
   */
  requestTap(reason: string, request: TapRequest): Promise<Attribution | null>;
}

export interface ScaleCaptureSlotProps {
  deviceCodes: readonly string[];
  purpose: 'TARE' | 'GROSS' | 'CHECK';
  onCaptured: (reading: ReadingView) => void;
  disabled?: boolean;
}

const notEnabled = (what: string, owner: string): RefusalEnvelope => ({
  refusal: {
    code: 'NOT_IMPLEMENTED',
    kind: 'NOT_ENABLED',
    whatHappened: `${what} is not available yet.`,
    why: `It arrives with module ${owner}.`,
    controls: [],
    whatYouCanDo: ['Use another path for now.'],
    whoCanHelp: [],
  },
  correlationId: 'client',
  retryable: false,
});

export const STUB_CEREMONY: SignatureCeremonyPort = {
  sign: () => Promise.resolve({ status: 'REFUSED', refusal: notEnabled('Electronic signing', 'C1') }),
};

export const STUB_BADGE_TAP: BadgeTapPort = {
  requestTap: () => Promise.resolve(null),
};

export function StubScaleCaptureSlot(props: ScaleCaptureSlotProps) {
  void props;
  return (
    <Banner tone="info" title="Scale capture is not connected yet">
      Enter the weights by hand; a second person must then verify the step.
    </Banner>
  );
}

const CeremonyContext = createContext<SignatureCeremonyPort>(STUB_CEREMONY);
const BadgeTapContext = createContext<BadgeTapPort>(STUB_BADGE_TAP);
const ScaleSlotContext = createContext<ComponentType<ScaleCaptureSlotProps>>(StubScaleCaptureSlot);

export const useSignatureCeremony = (): SignatureCeremonyPort => useContext(CeremonyContext);
export const useBadgeTap = (): BadgeTapPort => useContext(BadgeTapContext);
export const useScaleCaptureSlot = (): ComponentType<ScaleCaptureSlotProps> => useContext(ScaleSlotContext);

/** The scale capture slot the step screen renders (C5 provides the gauge and capture buttons). */
export function ScaleCaptureSlot(props: ScaleCaptureSlotProps) {
  return createElement(useScaleCaptureSlot(), props);
}

export function CeremonyPortProvider({ value, children }: { value: SignatureCeremonyPort; children: ReactNode }) {
  return <CeremonyContext.Provider value={value}>{children}</CeremonyContext.Provider>;
}
export function BadgeTapPortProvider({ value, children }: { value: BadgeTapPort; children: ReactNode }) {
  return <BadgeTapContext.Provider value={value}>{children}</BadgeTapContext.Provider>;
}
export function ScaleSlotProvider({ value, children }: { value: ComponentType<ScaleCaptureSlotProps>; children: ReactNode }) {
  return <ScaleSlotContext.Provider value={value}>{children}</ScaleSlotContext.Provider>;
}
