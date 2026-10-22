export type ConsultationMode = "audio" | "video" | "chat";
export type AvailabilityStatus = "online" | "busy" | "offline" | "unknown";

/** Fields a provider may leave out; tracked so eligibility can apply the missing-data policy. */
export type ProfileField =
  | "languages"
  | "categories"
  | "specializations"
  | "experienceYears"
  | "rating"
  | "avatarUrl"
  | "about"
  | "availability"
  | "consultationModes"
  | "onboardedAt"
  | "payout";

export interface PricePackage {
  minutes: number;
  /** What the user pays for the package. */
  price: number;
}

/**
 * The one common astrologer model every provider feed is normalized into.
 * Contact details (phone, email) are deliberately not part of it.
 */
export interface AstrologerProfile {
  /** Stable global id: `${providerId}:${sourceId}`. */
  id: string;
  providerId: string;
  /** Slug of the provider's identifier; forms the global id. */
  sourceId: string;
  /** The provider's native identifier, when it differs from sourceId (used for API calls). */
  externalId?: string;

  name: string;
  tagline?: string;
  about?: string;
  avatarUrl?: string;
  profileUrl?: string;

  /** Catalog ids (config.catalog.*). */
  languages: string[];
  categories: string[];
  specializations: string[];
  consultationModes: ConsultationMode[];

  experienceYears: number | null;
  rating: number | null;
  reviewCount: number;

  pricing: {
    /** User-facing price per minute (INR). */
    perMinute: number;
    minCallMinutes: number | null;
    packages: PricePackage[];
    /** Astrologer's payout per minute, when the provider shares it. */
    payoutPerMinute: number | null;
  };

  availability: {
    status: AvailabilityStatus;
    lastActiveAt: number | null;
  };

  /** Provider-assigned tier label, e.g. "T1". */
  tier?: string;
  verified: boolean;
  /** Epoch ms the astrologer joined the provider, if known. */
  onboardedAt: number | null;

  dataQuality: {
    /** Fields the provider did not supply (vs. supplied as empty). */
    missing: ProfileField[];
    /** Raw provider values that didn't map to a catalog id. */
    unmapped: string[];
  };

  source: {
    importedAt: number;
    /** Row index / record key in the provider feed. */
    ref?: string;
  };
}

/** Public-facing astrologer shape returned by the ranking API. */
export interface Astrologer {
  id: string;
  providerId: string;
  name: string;
  tagline?: string;
  languages: string[];
  categories: string[];
  specializations: string[];
  consultationModes: ConsultationMode[];
  experienceYears: number | null;
  rating: number | null;
  reviewCount: number;
  pricePerMinute: number;
  isOnline: boolean;
  avatarUrl?: string;
}
