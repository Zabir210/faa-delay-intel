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
