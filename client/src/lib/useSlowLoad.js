import { useEffect, useState } from "react";

/**
 * True once `active` has stayed true for longer than `delayMs`.
 * Used to explain a slow first request: a free-tier host sleeps when idle and
 * takes the better part of a minute to wake, which otherwise just looks broken.
 */
export function useSlowLoad(active, delayMs = 4000) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return undefined;
    }
    const id = setTimeout(() => setSlow(true), delayMs);
    return () => clearTimeout(id);
  }, [active, delayMs]);
  return slow;
}
