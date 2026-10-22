import type { SignalName } from "@/config";
import { availabilityStatusSignal, callReadySignal, providerCapacitySignal } from "./astrologer/availability";
import { categoryMatchSignal, specializationMatchSignal } from "./astrologer/categoryMatch";
import { experienceSignal } from "./astrologer/experience";
import { languageMatchSignal } from "./astrologer/langugageMatch";
import { acceptanceRateSignal, completionRateSignal, complaintFreeSignal, repeatRateSignal } from "./astrologer/quality";
import { ratingSignal, reviewConfidenceSignal } from "./astrologer/rating";
import { contributionMarginSignal } from "./business/contributionMargin";
import { conversionSignal } from "./business/conversion";
import { expectedDurationSignal, expectedRevenueSignal } from "./business/expectedRevenue";
import { explorationSignal } from "./exploration/explorationScore";
import type { Signal } from "./types";
import { categoryAffinitySignal } from "./user/categoryAffinity";
import { priceAffinitySignal } from "./user/priceAffinity";
import { repeatAstrologerSignal } from "./user/repeatAstrologer";
import { languageAffinitySignal, providerAffinitySignal } from "./user/userAffinity";

/**
 * Every component the scorer evaluates. Typed as a full record so a
 * component added to config.SIGNALS without an implementation fails to compile.
 */
export const SIGNAL_REGISTRY: Readonly<Record<SignalName, Signal>> = {
  rating: ratingSignal,
  reviewConfidence: reviewConfidenceSignal,
  experience: experienceSignal,
  completionRate: completionRateSignal,
  acceptanceRate: acceptanceRateSignal,
  complaintFree: complaintFreeSignal,
  repeatRate: repeatRateSignal,
  repeatAstrologer: repeatAstrologerSignal,
  categoryAffinity: categoryAffinitySignal,
  languageAffinity: languageAffinitySignal,
  providerAffinity: providerAffinitySignal,
  expectedRevenue: expectedRevenueSignal,
  contributionMargin: contributionMarginSignal,
  conversion: conversionSignal,
  expectedDuration: expectedDurationSignal,
  priceAffinity: priceAffinitySignal,
  categoryMatch: categoryMatchSignal,
  specializationMatch: specializationMatchSignal,
  availabilityStatus: availabilityStatusSignal,
  callReady: callReadySignal,
  providerCapacity: providerCapacitySignal,
  exploration: explorationSignal,
  languageMatch: languageMatchSignal,
};
