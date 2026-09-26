/* The TCP socket factory SMTP uses; stubbed under Vitest. */

import { connect as open } from "cloudflare:sockets";
import type { Connect } from "./smtp";

export const connect: Connect = (address, options) => open(address, { ...options, allowHalfOpen: false });
