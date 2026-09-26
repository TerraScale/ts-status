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
  /** The public origin, for links in notifications. */
  PUBLIC_ORIGIN?: string;
  /** Signs subscription links and generic webhooks (a Worker secret). */
  SUBSCRIPTION_SECRET?: string;
  /** OCI Email Delivery's SMTP relay (secrets), as ts-auth uses it. */
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM?: string;
  /** Limits subscription requests per client. */
  SUBSCRIBE_LIMITER?: RateLimit;
}
