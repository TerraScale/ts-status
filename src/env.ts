/* The Worker's bindings. */

import type { Coordinator } from "./probe/coordinator";

export interface Env {
  STATUS_DB: D1Database;
  COORDINATOR: DurableObjectNamespace<Coordinator>;
  VANTAGE_SFO: Fetcher;
  VANTAGE_GRU: Fetcher;
  VANTAGE_FRA: Fetcher;
  VANTAGE_NRT: Fetcher;
  /** Bearer token of the operator API (a Worker secret). */
  OPERATOR_TOKEN?: string;
}
