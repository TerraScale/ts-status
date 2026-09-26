/* What the coordinator asks a vantage Worker, and what it answers. */

/** One URL to probe; endpoints sharing a URL and headers share a target. */
export interface Target {
  key: string;
  url: string;
  /** JSON object of request headers. */
  headers: string;
}

export interface ProbeRequest {
  targets: Target[];
}

export interface TargetResult {
  key: string;
  ok: boolean;
  latencyMs: number;
  error: string | null;
}

export interface ProbeResponse {
  vantage: string;
  /** The data center the vantage ran in, e.g. "GRU". */
  colo: string | null;
  results: TargetResult[];
}
