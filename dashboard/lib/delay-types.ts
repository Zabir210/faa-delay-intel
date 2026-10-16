// Shared by server queries and client charts; must not import the DB client.
export const DELAY_TYPES = ["delay", "ground_delay", "ground_stop", "closure"] as const;
export type DelayType = (typeof DELAY_TYPES)[number];

export const TYPE_LABEL: Record<DelayType, string> = {
  delay: "Delay",
  ground_delay: "Ground delay",
  ground_stop: "Ground stop",
  closure: "Closure",
};

export type DailyActivity = {
  day: string; // YYYY-MM-DD (UTC)
  counts: Record<DelayType, number>;
  /** ingest runs that day; 0 means the pipeline was down, not a calm day */
  runs: number;
};

/** Types that carry a delay in minutes; stops and closures are on/off. */
export const MINUTE_TYPES = ["delay", "ground_delay"] as const satisfies readonly DelayType[];
export const SPAN_TYPES = ["ground_stop", "closure"] as const satisfies readonly DelayType[];

export type AirportTimeline = {
  /** bucket start times, ISO, evenly spaced by bucketMinutes */
  buckets: string[];
  bucketMinutes: number;
  /** worst max_delay_minutes seen in each bucket; null = not reported */
  minutes: Record<(typeof MINUTE_TYPES)[number], (number | null)[]>;
  /** whether the type was reported at all in each bucket */
  active: Record<(typeof SPAN_TYPES)[number], boolean[]>;
  /** buckets with no ok ingest run: unknown, not calm */
  offline: boolean[];
};
