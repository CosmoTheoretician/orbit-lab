export type Operator = "ses" | "starlink" | "oneweb" | "amazonLeo" | "other";

export interface CatalogEntry {
  name: string;
  norad: number;
  operator: Operator;
  line1: string;
  line2: string;
}

export interface CatalogFile {
  fetchedAt: string;
  entries: CatalogEntry[];
}

export const OPERATORS: Record<Operator, { label: string; color: number }> = {
  ses:       { label: "SES / Intelsat",   color: 0xffc400 },
  starlink:  { label: "SpaceX Starlink",  color: 0xe8e8e8 },
  oneweb:    { label: "Eutelsat OneWeb",  color: 0x33d6ff },
  amazonLeo: { label: "Amazon Leo",       color: 0xff7a1a },
  other:     { label: "Other active",     color: 0x5a6b80 },
};