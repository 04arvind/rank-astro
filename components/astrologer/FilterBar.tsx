"use client";

export interface FilterOption {
  id: string;
  label: string;
}

/** Mirrors the `context` / `filters` fields of the rank API request. */
export interface FilterValue {
  category?: string;
  languages: string[];
  minPrice?: number;
  maxPrice?: number;
  onlineOnly: boolean;
}

interface FilterBarProps {
  value: FilterValue;
  onChange: (next: FilterValue) => void;
  categories: readonly FilterOption[];
  languages: readonly FilterOption[];
}

const toNumber = (v: string) => (v === "" ? undefined : Number(v));

export default function FilterBar({ value, onChange, categories, languages }: FilterBarProps) {
  const set = (patch: Partial<FilterValue>) => onChange({ ...value, ...patch });

  const toggleLanguage = (id: string) =>
    set({
      languages: value.languages.includes(id)
        ? value.languages.filter((l) => l !== id)
        : [...value.languages, id],
    });

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-white/70 bg-white/65 p-4 shadow-[0_10px_30px_-20px_rgba(61,37,114,0.45)] ring-1 ring-celestial-900/5 backdrop-blur-md">
      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Category">
        {[{ id: "", label: "All" }, ...categories].map((c) => {
          const active = (value.category ?? "") === c.id;
          return (
            <button
              key={c.id || "all"}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => set({ category: c.id || undefined })}
              className={`shrink-0 rounded-full px-3.5 py-1 text-sm transition ${
                active
                  ? "bg-gradient-to-r from-celestial-600 to-celestial-800 text-white shadow-[0_6px_16px_-8px_rgba(82,51,150,0.8)]"
                  : "border border-lavender-200 bg-ivory-50/70 text-celestial-800 hover:border-celestial-400/50 hover:bg-lavender-50"
              }`}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm text-celestial-800">
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="sr-only">Languages</legend>
          {languages.map((l) => (
            <label key={l.id} className="flex items-center gap-1">
              <input
                type="checkbox"
                className="accent-celestial-600"
                checked={value.languages.includes(l.id)}
                onChange={() => toggleLanguage(l.id)}
              />
              {l.label}
            </label>
          ))}
        </fieldset>

        <div className="flex items-center gap-1">
          <span className="text-celestial-800/60">₹/min</span>
          <input
            type="number"
            min={0}
            placeholder="Min"
            value={value.minPrice ?? ""}
            onChange={(e) => set({ minPrice: toNumber(e.target.value) })}
            className="w-20 rounded-lg border border-lavender-200 bg-ivory-50/80 px-2 py-1 text-celestial-900 placeholder:text-celestial-800/40 focus:border-celestial-400 focus:outline-none focus:ring-2 focus:ring-lavender-200"
          />
          <span className="text-celestial-800/40">–</span>
          <input
            type="number"
            min={0}
            placeholder="Max"
            value={value.maxPrice ?? ""}
            onChange={(e) => set({ maxPrice: toNumber(e.target.value) })}
            className="w-20 rounded-lg border border-lavender-200 bg-ivory-50/80 px-2 py-1 text-celestial-900 placeholder:text-celestial-800/40 focus:border-celestial-400 focus:outline-none focus:ring-2 focus:ring-lavender-200"
          />
        </div>

        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            className="accent-celestial-600"
            checked={value.onlineOnly}
            onChange={(e) => set({ onlineOnly: e.target.checked })}
          />
          Online only
        </label>
      </div>
    </div>
  );
}
