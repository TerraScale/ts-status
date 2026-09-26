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
}

export const VANTAGES: readonly Vantage[] = [
  { code: "sfo", name: "US West", placement: "aws:us-west-1", binding: "VANTAGE_SFO" },
  { code: "gru", name: "South America", placement: "aws:sa-east-1", binding: "VANTAGE_GRU" },
  { code: "fra", name: "Europe", placement: "aws:eu-central-1", binding: "VANTAGE_FRA" },
  { code: "nrt", name: "Asia Pacific", placement: "aws:ap-northeast-1", binding: "VANTAGE_NRT" },
];

export const vantageWorkerName = (vantage: Pick<Vantage, "code">): string => `ts-status-vantage-${vantage.code}`;
