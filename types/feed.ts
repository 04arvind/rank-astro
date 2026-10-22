import type { RankedAstrologer } from "./ranking";

export type FeedColumnId = "recommended" | "popular" | "personalized" | "premium";

export interface FeedItem extends RankedAstrologer {
  /** 1-based position inside its column; `rank` stays the overall ranking position. */
  position: number;
  /** Column-specific label, e.g. "You consulted before", "Similar to Asha". */
  highlight?: string;
  /** Personalized column: a "similar to" pick, listed after direct matches. */
  related?: boolean;
}

export interface FeedColumn {
  id: FeedColumnId;
  title: string;
  subtitle: string;
  items: FeedItem[];
}

export interface HomeFeed {
  /** In display order: recommended, popular, personalized, premium. */
  columns: FeedColumn[];
  /** Eligible astrologers behind the page. */
  total: number;
}
