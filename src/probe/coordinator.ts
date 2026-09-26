/* The probe coordinator: one Durable Object whose alarm fires every 30
   seconds and runs a probe round. It is the only writer of probe samples,
   so rounds never overlap. It sits near the D1 primary; the minute cron
   re-arms it should the alarm ever be lost. */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { ROUND_MS, roundOf, runRound, type RoundState } from "./round";

interface State extends Partial<RoundState> {
  /** The last round stored. */
  round?: number;
}

export class Coordinator extends DurableObject<Env> {
  /** Schedules the next round unless one is already scheduled. */
  async arm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(roundOf(Date.now()) + ROUND_MS);
    }
  }

  override async alarm(): Promise<void> {
    const at = roundOf(Date.now());
    await this.ctx.storage.setAlarm(at + ROUND_MS);

    const state = (await this.ctx.storage.get<State>("state")) ?? {};
    if (state.round !== undefined && state.round >= at) return;
    try {
      const result = await runRound(this.env, at, {
        streaks: state.streaks ?? {},
        colos: state.colos ?? {},
        versions: state.versions ?? {},
      });
      await this.ctx.storage.put<State>("state", { round: at, ...result });
    } catch (error) {
      // The next round runs in 30 seconds; retrying this one would only
      // delay it.
      console.error("probe round failed", error);
    }
  }
}

/** The coordinator, created near the D1 primary (eastern North America). */
export function coordinator(env: Env): DurableObjectStub<Coordinator> {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName("coordinator"), { locationHint: "enam" });
}
