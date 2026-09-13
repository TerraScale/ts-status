import { env } from "cloudflare:workers";

export interface StatusEnv {
  STATUS_DB: D1Database;
  STATUS_ADMIN_TOKEN?: string;
  STATUS_PAGE_NAME?: string;
  STATUS_PAGE_URL?: string;
}

export function getStatusEnv(): StatusEnv {
  return env as unknown as StatusEnv;
}
