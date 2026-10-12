/* The vantage points: one VantagePoint Durable Object each, created near a
   location hint so every endpoint is probed from four continents. A hint is
   a preference: Cloudflare may create an object elsewhere (South America
   most often), and every answer reports the data center it really ran in. */

import type { Env } from "../env";

export interface Vantage {
  code: "sfo" | "gru" | "fra" | "nrt";
  name: string;
  /** The location hint the vantage's Durable Object is created near. */
  placement: DurableObjectLocationHint;
  /** Position in region map viewBox units (MAP_WIDTH × MAP_HEIGHT in
      views/charts/geometry), just off the hub of the region it sits in. */
  mapX: number;
  mapY: number;
  /** The region hub it sits beside, which gets no probe path from it. */
  region: string | null;
}

export const VANTAGES: readonly Vantage[] = [
  {
    code: "sfo",
    name: "US West",
    placement: "wnam",
    mapX: 18.8,
    mapY: 31.4,
    region: "SJC",
  },
  {
    code: "gru",
    name: "South America",
    placement: "sam",
    mapX: 47.4,
    mapY: 62.4,
    region: "GRU",
  },
  {
    code: "fra",
    name: "Europe",
    placement: "weur",
    mapX: 69.3,
    mapY: 23.6,
    region: "FRA",
  },
  {
    code: "nrt",
    name: "Asia Pacific",
    placement: "apac",
    mapX: 120.5,
    mapY: 29.8,
    region: null,
  },
];

/** The vantage's Durable Object; it stays where it was first created. */
export const vantageStub = (env: Pick<Env, "VANTAGE">, vantage: Pick<Vantage, "code" | "placement">) =>
  env.VANTAGE.get(env.VANTAGE.idFromName(vantage.code), { locationHint: vantage.placement });
