import { Throttle } from "@nestjs/throttler";

/**
 * Payment-initiation endpoints get a tighter limit than reads — initiating an STK
 * push has real-world cost (an SMS/prompt sent to a phone) and is the endpoint most
 * worth protecting from abuse or a buggy retry loop on a tenant's integration.
 */
export const StrictPaymentThrottle = () => Throttle({ default: { limit: 10, ttl: 60_000 } }); // 10/min

/** Reads are cheap; generous but still bounded. */
export const ReadThrottle = () => Throttle({ default: { limit: 120, ttl: 60_000 } }); // 120/min

/**
 * The Daraja webhook endpoint is unauthenticated by nature (Safaricom calls it
 * directly) — its real protection is idempotency + CheckoutRequestID matching, but
 * a generous ceiling still guards against it being discovered and hammered.
 */
export const WebhookThrottle = () => Throttle({ default: { limit: 300, ttl: 60_000 } }); // 300/min
