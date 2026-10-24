import { AppError, type AppErrorDetails } from "./AppError";

/**
 * Thrown when a request lacks valid authentication credentials (HTTP 401).
 *
 * @example
 *   throw new UnauthorizedError("Missing challenge or signature");
 *   throw new UnauthorizedError("Invalid signature", undefined, correlationId);
 */
export class UnauthorizedError extends AppError {
  constructor(
    message = "Unauthorized",
    details?: AppErrorDetails,
    correlationId?: string,
  ) {
    super(message, 401, "UNAUTHORIZED", details, correlationId);
    this.name = "UnauthorizedError";
  }
}
