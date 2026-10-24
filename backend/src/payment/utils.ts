export class PaymentAlreadyReleasedError extends Error {
  constructor(taskId: string, nodeId: string) {
    super(`Payment for task=${taskId} node=${nodeId} is already released`);
    this.name = "PaymentAlreadyReleasedError";
  }
}

export class HorizonUnavailableError extends Error {
  readonly code = "STELLAR_HORIZON_UNAVAILABLE";
  readonly statusCode = 503;

  constructor(attempts: number) {
    super(`Stellar Horizon unavailable after ${attempts} attempts`);
    this.name = "HorizonUnavailableError";
  }
}

/** 1 XLM = 10_000_000 stroops */
export function xlmToStroops(xlm: number): bigint {
  // toFixed(7) avoids scientific notation for very small values like 1e-7
  const fixed = xlm.toFixed(7);
  const [whole, frac] = fixed.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(frac);
}

export function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = stroops % 10_000_000n;
  return `${whole}.${frac.toString().padStart(7, "0")}`;
}
