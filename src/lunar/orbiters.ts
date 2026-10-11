export type OrbiterStatus = "operating" | "concluded" | "planned" | "unverified";

/** Keplerian orbit about the Moon, in lunar equatorial axes. `count` satellites spaced evenly in node and phase. */
export interface KeplerModel {
  aKm: number;
  e: number;
  iDeg: number;
  raanDeg: number;
  argpDeg: number;
  count: number;
  basis: string;
}

export interface LunarOrbiter {
  id: string;
  name: string;
  operator: string;
  country: string;
  sector: "government" | "commercial";
  status: OrbiterStatus;
  statusNote: string;
  role: string;
  /** Live ephemeris from JPL Horizons (Moon-centred), names tried with the lookup service. */
  horizons?: { lookup: string[] };
  model?: KeplerModel;
  notes: string[];
}

/**
 * Representative elliptical lunar frozen orbit (ELFO): stable eccentricity and argument of perilune;
 * ω = 90° puts apolune over the south pole, where these relay orbits spend most of their time.
 */
const ELFO = { aKm: 6540, e: 0.6, iDeg: 57, argpDeg: 90 };

export const LUNAR_ORBITERS: LunarOrbiter[] = [
  // ---------------- in lunar orbit ----------------
  {
    id: "lro", name: "Lunar Reconnaissance Orbiter", operator: "NASA", country: "USA", sector: "government",
    status: "operating", statusNote: "mapping since 2009", role: "mapping, reference for lunar navigation experiments",
    horizons: { lookup: ["LRO", "Lunar Reconnaissance Orbiter"] },
    notes: ["Ephemeris: JPL Horizons, Moon-centred"],
  },
  {
    id: "chandrayaan-2", name: "Chandrayaan-2 orbiter", operator: "ISRO", country: "India", sector: "government",
    status: "operating", statusNote: "operating since 2019", role: "mapping and remote sensing",
    horizons: { lookup: ["Chandrayaan-2", "Chandrayaan 2"] },
    notes: ["Ephemeris: JPL Horizons, Moon-centred"],
  },
  {
    id: "danuri", name: "Danuri (KPLO)", operator: "KARI / KASA", country: "South Korea", sector: "government",
    status: "operating", statusNote: "extended mission", role: "remote sensing; carries NASA's ShadowCam",
    horizons: { lookup: ["Danuri", "KPLO"] },
    notes: ["Ephemeris: JPL Horizons, Moon-centred"],
  },
  {
    id: "capstone", name: "CAPSTONE", operator: "NASA / Advanced Space", country: "USA", sector: "government",
    status: "concluded", statusNote: "NASA activities concluded June 2026", role: "near-rectilinear halo orbit pathfinder",
    horizons: { lookup: ["CAPSTONE"] },
    notes: ["Ephemeris: JPL Horizons, Moon-centred (may end when tracking stopped)"],
  },
  {
    id: "artemis-p1", name: "ARTEMIS P1", operator: "NASA", country: "USA", sector: "government",
    status: "operating", statusNote: "in lunar orbit since 2011; current status not verified", role: "space physics (ex THEMIS-B)",
    horizons: { lookup: ["ARTEMIS-P1", "THEMIS-B", "ARTEMIS P1"] },
    notes: ["Ephemeris: JPL Horizons, Moon-centred"],
  },
  {
    id: "artemis-p2", name: "ARTEMIS P2", operator: "NASA", country: "USA", sector: "government",
    status: "operating", statusNote: "in lunar orbit since 2011; current status not verified", role: "space physics (ex THEMIS-C)",
    horizons: { lookup: ["ARTEMIS-P2", "THEMIS-C", "ARTEMIS P2"] },
    notes: ["Ephemeris: JPL Horizons, Moon-centred"],
  },
  {
    id: "queqiao-2", name: "Queqiao-2", operator: "CNSA", country: "China", sector: "government",
    status: "operating", statusNote: "relay since 2024", role: "relay for the far side and south pole",
    model: { aKm: 1737.4 + (254 + 16941) / 2, e: (16941 - 254) / (16941 + 254 + 2 * 1737.4), iDeg: 119.25, raanDeg: 0, argpDeg: 270, count: 1,
      basis: "published 254 × 16,941 km, 119.25° (Wikipedia); orientation assumed" },
    notes: [
      "Not in JPL Horizons: modeled from its published orbit",
      "A move to a 12-hour orbit for Chang'e-7 was announced; Chang'e-7 has since been postponed",
    ],
  },

  {
    id: "khon-1", name: "Khon-1", operator: "Intuitive Machines", country: "USA", sector: "commercial",
    status: "unverified", statusNote: "launched with IM-2 in February 2025; current status not verified",
    role: "first Khonstellation data relay node (York Space Systems S-CLASS bus)",
    horizons: { lookup: ["Khon-1", "Khon 1", "Khon"] },
    notes: ["Shown only if JPL Horizons has an ephemeris for it"],
  },

  // ---------------- planned ----------------
  {
    id: "im-ldn", name: "IM Lunar Data Network", operator: "Intuitive Machines (NASA LCRNS)", country: "USA", sector: "commercial",
    status: "planned", statusNote: "Altus-1 on IM-3 (Q1 2027); remaining four deployed together in 2028 (Q2 2026 earnings call)",
    role: "communications relay and positioning, navigation and timing",
    model: { ...ELFO, raanDeg: 0, count: 5, basis: "representative ELFO; five-satellite elliptical frozen orbit design (NASA NTRS)" },
    notes: ["Exact orbital elements not published"],
  },
  {
    id: "lunar-pathfinder", name: "Lunar Pathfinder", operator: "SSTL / ESA", country: "UK / Europe", sector: "commercial",
    status: "planned", statusNote: "launch on a Firefly Blue Ghost mission; date to be confirmed",
    role: "commercial data relay; GPS/Galileo reception test",
    model: { ...ELFO, raanDeg: 36, count: 1, basis: "representative ELFO (Lunar Pathfinder operates in an ELFO)" },
    notes: ["Exact orbital elements not published", "Precursor of ESA's Moonlight constellation"],
  },
  {
    id: "moonlight", name: "Moonlight LCNS", operator: "ESA / Telespazio consortium", country: "Europe", sector: "government",
    status: "planned", statusNote: "maiden launch planned 2028",
    role: "communications (1 satellite) and navigation (4 satellites)",
    model: { ...ELFO, raanDeg: 18, count: 5, basis: "representative ELFO; constellation geometry not published" },
    notes: ["Exact orbital elements not published", "Three dedicated ground stations on Earth"],
  },
];
