"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Refreshes visible status data at a low cadence without background polling. */
export function StatusRefresh() {
  const router = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (document.visibilityState !== "visible") return;
      timer = setTimeout(() => {
        router.refresh();
        schedule();
      }, 120_000);
    };
    const onVisibility = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router]);
  return null;
}
