import { config } from "@/config";
import { ConfigurationError, logError } from "@/lib/errors";
import { providerA } from "./providerA";
import { providerB } from "./providerB";
import { providerC } from "./providerC";
import type { ProviderAdapter } from "./types";

const adapters = new Map<string, ProviderAdapter<never>>(
  [providerA, providerB, providerC].map((a) => [a.id, a as ProviderAdapter<never>]),
);

for (const p of config.providers.providers) {
  if (!adapters.has(p.id)) {
    logError(new ConfigurationError("Provider is configured but has no adapter", { providerId: p.id }), { scope: "providers" });
  }
}

export function getProviderAdapter(providerId: string): ProviderAdapter | undefined {
  return adapters.get(providerId) as ProviderAdapter | undefined;
}
