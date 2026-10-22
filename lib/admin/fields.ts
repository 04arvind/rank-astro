/*
 * Target fields an uploaded astrologer sheet can be mapped onto, and the
 * header spellings that auto-detect them. Contact columns (phone, email…)
 * have no target on purpose: they never leave the sheet.
 */

export const IMPORT_FIELDS = [
  { key: "name", label: "Name", required: true },
  { key: "externalId", label: "Provider astrologer id" },
  { key: "perMinute", label: "Price per minute (₹)", required: true },
  { key: "languages", label: "Languages" },
  { key: "categories", label: "Categories" },
  { key: "specializations", label: "Specializations" },
  { key: "expertise", label: "Expertise (categories + specializations)" },
  { key: "consultationModes", label: "Consultation modes" },
  { key: "experienceYears", label: "Experience (years)" },
  { key: "rating", label: "Rating (0–5)" },
  { key: "reviewCount", label: "Review count" },
  { key: "minCallMinutes", label: "Min call minutes" },
  { key: "package", label: "Package price (minutes from header)" },
  { key: "payoutPerMinute", label: "Payout per minute" },
  { key: "currency", label: "Currency" },
  { key: "status", label: "Availability status" },
  { key: "availableForCall", label: "Available for call (yes/no)" },
  { key: "verified", label: "Verified (yes/no)" },
  { key: "tier", label: "Tier" },
  { key: "about", label: "About / bio" },
  { key: "tagline", label: "Tagline" },
  { key: "avatarUrl", label: "Photo URL" },
  { key: "profileUrl", label: "Profile URL" },
  { key: "onboardedAt", label: "Joined on (date)" },
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number]["key"];
export type ColumnMapping = Record<string, ImportField | "ignore">;

export const isImportField = (v: unknown): v is ImportField => IMPORT_FIELDS.some((f) => f.key === v);

/** "Price / Min (₹)" → "priceminrs"-ish key for alias lookup. */
const norm = (h: string) => h.toLowerCase().replace(/₹/g, "rs").replace(/[^a-z0-9]+/g, "");

const ALIASES: Record<ImportField, string[]> = {
  name: ["name", "astrologername", "fullname", "displayname", "astrologer", "nameofastrologer", "astroname"],
  externalId: ["id", "astrologerid", "providerastrologerid", "astroid", "code", "astrologercode", "profileid", "userid", "uid"],
  perMinute: [
    "perminute", "perminutecall", "priceperminute", "pricepermin", "permin", "rate", "rateperminute", "ratepermin",
    "charges", "chargeperminute", "chargepermin", "price", "fee", "fees", "callprice", "callrate", "pricing", "priceperminuters",
  ],
  languages: ["language", "languages", "languagesknown", "knownlanguages", "langs", "lang", "spokenlanguages"],
  categories: ["category", "categories", "topics", "topic", "consultationcategory", "concerns", "areas"],
  specializations: ["specialization", "specializations", "specialisation", "specialisations", "speciality", "specialty", "disciplines"],
  expertise: ["expertise", "skills", "skill", "expertiseareas", "expert"],
  consultationModes: ["mode", "modes", "consultationmode", "consultationmodes", "services", "servicetype", "consultationtype", "channels"],
  experienceYears: ["experience", "experienceyears", "exp", "yearsofexperience", "experienceinyears", "expyears", "expinyears"],
  rating: ["rating", "ratings", "avgrating", "averagerating", "stars", "starrating"],
  reviewCount: ["reviews", "reviewcount", "noofreviews", "totalreviews", "numreviews", "ratingcount", "reviewscount"],
  minCallMinutes: ["mincalltime", "minimumcall", "mincallminutes", "minduration", "minimumduration", "mincall"],
  package: [],
  payoutPerMinute: ["payout", "payoutperminute", "astrologerpayout", "astrologershare", "payoutpermin"],
  currency: ["currency", "curr"],
  status: ["status", "availability", "onlinestatus", "availabilitystatus", "presence", "online"],
  availableForCall: ["availableforcall", "callavailable", "available", "callenabled"],
  verified: ["verified", "isverified", "kyc", "kycstatus", "approved", "verificationstatus", "verification"],
  tier: ["tier", "level", "grade", "rank"],
  about: ["about", "bio", "description", "aboutme", "summary", "biography"],
  tagline: ["tagline", "headline", "title"],
  avatarUrl: ["image", "photo", "avatar", "picture", "imageurl", "photourl", "profilepic", "profileimage", "avatarurl", "profilephoto"],
  profileUrl: ["link", "url", "profileurl", "profilelink", "website"],
  onboardedAt: ["joined", "joinedon", "onboarded", "onboardedat", "joiningdate", "dateofjoining", "createdat", "joindate"],
};

const BY_ALIAS = new Map<string, ImportField>(
  (Object.entries(ALIASES) as [ImportField, string[]][]).flatMap(([field, list]) => list.map((a) => [a, field] as const)),
);

/** Minutes in a package header: "Call/chat Price (30 Min)" → 30, "per 5 min cost" → 5. */
export function packageMinutes(header: string): number | undefined {
  const m = header.toLowerCase().match(/(\d+)\s*(?:min|minute)/);
  return m ? Number(m[1]) : undefined;
}

/** Headers that name contact details; never mapped. */
const CONTACT = /phone|mobile|email|e-mail|whatsapp|contact|address|aadha?r|pan\b|bank|ifsc|account/i;

function guess(header: string): ImportField | "ignore" {
  if (CONTACT.test(header)) return "ignore";
  const key = norm(header);
  const exact = BY_ALIAS.get(key);
  if (exact) return exact;

  const h = header.toLowerCase();
  if (/page\s*lang|astrologer\s*(charge|share)|serial|^s\.?\s*no/.test(h)) return "ignore";
  if (/\bmin(imum)?\b.*\b(call|time|duration)\b/.test(h)) return "minCallMinutes";
  // "Call/chat Price (30 Min)", "per 5 min cost" — a price for a fixed number of minutes.
  if (/(price|cost|rs|₹|charge)/.test(h) && packageMinutes(h) !== undefined && !/per\s*min/.test(h)) return "package";
  if (/\bname\b/.test(h)) return "name";
  if (/about|bio|description/.test(h)) return "about";
  if (/photo|image|avatar|picture/.test(h)) return "avatarUrl";
  if (/link|url/.test(h)) return "profileUrl";
  if (/lang/.test(h)) return "languages";
  if (/special/.test(h)) return "specializations";
  if (/expert|skill|categor|\btag\b/.test(h)) return "expertise";
  if (/experience|\bexp\b/.test(h)) return "experienceYears";
  if (/review/.test(h)) return "reviewCount";
  if (/rating|star/.test(h)) return "rating";
  if (/payout/.test(h)) return "payoutPerMinute";
  if (/per\s*min|\/\s*min|price|rate|charge/.test(h)) return "perMinute";
  if (/status|online/.test(h)) return "status";
  if (/verif|kyc/.test(h)) return "verified";
  if (/\bmode|service/.test(h)) return "consultationModes";
  if (/join|onboard/.test(h)) return "onboardedAt";
  return "ignore";
}

/** Fields whose values are combined across several columns. */
const MULTI = new Set<ImportField>(["package", "languages", "categories", "specializations", "expertise", "consultationModes"]);

/**
 * Best-effort header → field mapping. Each single-valued field is taken by
 * the first header that claims it; later claimants fall back to "ignore".
 * List fields and package columns may repeat.
 */
export function detectMapping(headers: readonly string[]): ColumnMapping {
  const taken = new Set<ImportField>();
  const out: ColumnMapping = {};
  for (const h of headers) {
    const field = guess(h);
    if (field !== "ignore" && !MULTI.has(field) && taken.has(field)) {
      out[h] = "ignore";
      continue;
    }
    if (field !== "ignore") taken.add(field);
    out[h] = field;
  }
  return out;
}

export function isContactHeader(header: string): boolean {
  return CONTACT.test(header);
}
