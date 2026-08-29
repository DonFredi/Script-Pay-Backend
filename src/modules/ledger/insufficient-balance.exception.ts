import { UnprocessableEntityException } from "@nestjs/common";

/**
 * 422, not 400: the request is perfectly well-formed, it just can't be fulfilled
 * against this tenant's current balance. A 400 would tell an integrating tenant to
 * go fix their request payload, which is the wrong instruction — the fix is to
 * collect more money or send less.
 *
 * The amounts are repeated in the human-readable message on purpose.
 * HttpExceptionFilter only forwards `message` (plus `error.details` when a zod
 * `issues` array is present), so structured fields set here would never reach the
 * caller — putting them in the message is what actually makes them visible to a
 * tenant's integration. They're kept as properties too, for tests and for any
 * server-side caller that wants the numbers without parsing prose.
 */
export class InsufficientBalanceException extends UnprocessableEntityException {
  constructor(
    readonly availableMinorUnits: number,
    readonly requestedMinorUnits: number,
  ) {
    super(
      `Insufficient balance: requested ${formatMinorUnits(requestedMinorUnits)}, ` +
        `available ${formatMinorUnits(availableMinorUnits)}`,
    );
  }
}

/** Minor units are integer KES cents — never render them by dividing into a float for storage. */
function formatMinorUnits(minorUnits: number): string {
  const sign = minorUnits < 0 ? "-" : "";
  const absolute = Math.abs(minorUnits);
  return `${sign}KES ${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}
