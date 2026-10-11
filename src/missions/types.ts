export type Sector = "government" | "commercial";

export type Outcome = "landed" | "landed-anomaly" | "crashed" | "lost" | "returned" | "orbiting" | "planned";

/** Published milestones used to reconstruct a direct-transfer landing. All times are UTC ISO strings. */
export interface ReconstructionSpec {
  tli: string;
  parkAltKm: number;
  loi: { time: string; window?: [string, string] };
  orbitAltKm: number;
  doi?: string;
  pdiAltKm: number;
  pdiDurationS: number;
  landing: string;
  heading: "south" | "north";
  approachOver?: { lat: number; lon: number; label: string };
  notes: string[];
}

/** Lunar operations only, from orbit insertion to touchdown or impact. All times are UTC ISO strings. */
export interface LunarOpsSpec {
  loi: string;
  capture: { periAltKm: number; apoAltKm: number };
  circularBy: string;
  orbitAltKm: number;
  inclinationDeg?: number;
  heading: "south" | "north";
  descentStart: string;
  pdiAltKm: number;
  pdiDurationS: number;
  landing: string;
  crash?: { freeFallFromKm: number };
  notes: string[];
}

export interface Mission {
  id: string;
  name: string;
  operator: string;
  country: string;
  sector: Sector;
  outcome: Outcome;
  launch: string;
  horizons?: { lookup: string[]; start: string; stop: string };
  reconstruction?: ReconstructionSpec;
  lunarOps?: LunarOpsSpec;
  site?: { lat: number; lon: number; label: string; approx?: boolean };
  timeline: Array<{ date: string; text: string }>;
  summary: string;
}
