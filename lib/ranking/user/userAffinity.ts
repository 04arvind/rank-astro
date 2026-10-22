import type { Signal } from "../types";

/** Share of the user's calls that went to astrologers speaking this astrologer's languages. */
export const languageAffinitySignal: Signal = {
  name: "languageAffinity",
  audience: "internal",
  compute({ astrologer: a }, { user }) {
    if (user.languageAffinity.size === 0) return { value: null, detail: { history: 0 } };
    const value = Math.max(0, ...a.languages.map((l) => user.languageAffinity.get(l) ?? 0));
    return { value, detail: { share: value } };
  },
};

/** Share of the user's calls that went to this astrologer's provider. */
export const providerAffinitySignal: Signal = {
  name: "providerAffinity",
  audience: "internal",
  compute({ astrologer: a }, { user }) {
    if (user.providerAffinity.size === 0) return { value: null, detail: { history: 0 } };
    const value = user.providerAffinity.get(a.providerId) ?? 0;
    return { value, detail: { share: value } };
  },
};
