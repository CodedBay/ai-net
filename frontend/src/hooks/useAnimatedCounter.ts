// src/hooks/useAnimatedCounter.ts
import { useSpring, useMotionValueEvent } from "framer-motion";
import { useEffect, useState } from "react";

export interface UseAnimatedCounterOptions {
  /** Spring stiffness (default 80) */
  stiffness?: number;
  /** Spring damping (default 18) */
  damping?: number;
  /** Number of decimal places to round to (default 0) */
  decimals?: number;
}

/**
 * Animates a numeric value using a framer-motion spring, returning a
 * plain React state number so it can be safely rendered as text.
 * Starts from the previous value on updates, avoiding layout shift.
 */
export function useAnimatedCounter(
  target: number,
  options: UseAnimatedCounterOptions = {},
): number {
  const { stiffness = 80, damping = 18, decimals = 0 } = options;

  const spring = useSpring(0, { stiffness, damping });
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    spring.set(target);
  }, [target, spring]);

  useMotionValueEvent(spring, "change", (v) => {
    if (decimals > 0) {
      setDisplay(Number(v.toFixed(decimals)));
    } else {
      setDisplay(Math.round(v));
    }
  });

  return display;
}
