/* The vantage points: one small Worker each, placed near a cloud region
   so every endpoint is probed from four continents. Durable Objects cannot
   be placed in South America, so vantages are Workers with explicit
   placement, reached from the coordinator through service bindings. */

export interface Vantage {
  code: "sfo" | "gru" | "fra" | "nrt";
  name: string;
  /** Cloudflare places the Worker's fetch handler near this cloud region. */
  placement: string;
  binding: "VANTAGE_SFO" | "VANTAGE_GRU" | "VANTAGE_FRA" | "VANTAGE_NRT";
  /** Position on the 136×80 region map viewBox, just off the hub of the
      region it sits in. */
  mapX: number;
  mapY: number;
}

export const VANTAGES: readonly Vantage[] = [
  { code: "sfo", name: "US West", placement: "aws:us-west-1", binding: "VANTAGE_SFO", mapX: 18.8, mapY: 31.4 },
  { code: "gru", name: "South America", placement: "aws:sa-east-1", binding: "VANTAGE_GRU", mapX: 47.4, mapY: 62.4 },
  { code: "fra", name: "Europe", placement: "aws:eu-central-1", binding: "VANTAGE_FRA", mapX: 69.3, mapY: 23.6 },
  {
    code: "nrt",
    name: "Asia Pacific",
    placement: "aws:ap-northeast-1",
    binding: "VANTAGE_NRT",
    mapX: 120.5,
    mapY: 29.8,
  },
];

export const vantageWorkerName = (vantage: Pick<Vantage, "code">): string => `ts-status-vantage-${vantage.code}`;
