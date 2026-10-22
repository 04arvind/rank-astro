import type { CatalogConfig } from "./schema";

/**
 * Supported categories, specializations and languages. `aliases` hold the
 * spellings providers use, so normalization can map them onto one id.
 */
export const catalogConfig = {
  categories: [
    { id: "love", label: "Love", aliases: ["relationship", "relationships", "love & relationship"] },
    { id: "career", label: "Career", aliases: ["job", "business", "career & business"] },
    { id: "marriage", label: "Marriage", aliases: ["kundli matching", "matchmaking"] },
    { id: "finance", label: "Finance", aliases: ["money", "wealth"] },
    { id: "health", label: "Health", aliases: ["wellness"] },
    { id: "education", label: "Education", aliases: ["study", "studies"] },
  ],
  specializations: [
    { id: "vedic", label: "Vedic Astrology", aliases: ["vedic", "jyotish", "वैदिक ज्योतिष"] },
    { id: "numerology", label: "Numerology", aliases: ["अंक ज्योतिष"] },
    { id: "vastu", label: "Vastu", aliases: ["vastu shastra", "vastu science", "वास्तु"] },
    { id: "palmistry", label: "Palmistry", aliases: ["हस्तरेखा"] },
    { id: "tarot", label: "Tarot", aliases: ["tarot reading", "टैरो"] },
    { id: "kp", label: "KP System", aliases: ["kp", "krishnamurti paddhati", "kp सिस्टम"] },
    { id: "lal-kitab", label: "Lal Kitab", aliases: ["लाल किताब"] },
    { id: "reiki", label: "Reiki & Healing", aliases: ["reiki", "healing", "रेकी और हीलिंग"] },
  ],
  languages: [
    { id: "hindi", label: "Hindi", aliases: ["हिंदी", "hi"] },
    { id: "english", label: "English", aliases: ["अंग्रेज़ी", "en"] },
    { id: "punjabi", label: "Punjabi", aliases: ["पंजाबी", "pa"] },
    { id: "tamil", label: "Tamil", aliases: ["ta"] },
    { id: "telugu", label: "Telugu", aliases: ["te"] },
    { id: "bengali", label: "Bengali", aliases: ["bangla", "bn"] },
    { id: "marathi", label: "Marathi", aliases: ["mr"] },
  ],
} satisfies CatalogConfig;
