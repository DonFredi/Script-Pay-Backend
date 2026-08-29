/**
 * Daraja (Safaricom M-Pesa) Webhook Callback Interfaces
 *
 * Defines the structure of callbacks from Safaricom for:
 * - STK Push (payment prompts on phone)
 * - C2B Confirmation (paybill/till payments)
 */

/**
 * STK Push Callback
 * Sent by Safaricom after user enters PIN (or times out)
 *
 * Example response from Safaricom:
 * {
 *   "Body": {
 *     "stkCallback": {
 *       "MerchantCheckoutSessionID": "ws_CO_1234567890",
 *       "CheckoutRequestID": "ws_CO_1234567890",
 *       "ResultCode": 0,
 *       "ResultDesc": "The service request has been processed successfully.",
 *       "CallbackMetadata": {
 *         "Item": [
 *           { "Name": "Amount", "Value": 100 },
 *           { "Name": "MpesaReceiptNumber", "Value": "LHG31H5V60K0" },
 *           { "Name": "TransactionDate", "Value": 20231129133424 },
 *           { "Name": "PhoneNumber", "Value": 254717123456 }
 *         ]
 *       }
 *     }
 *   }
 * }
 */
export interface DarajaStkCallback {
  Body: {
    stkCallback: {
      MerchantCheckoutSessionID: string;
      CheckoutRequestID: string;
      ResultCode: number; // 0 = success, other = failure
      ResultDesc: string;
      CallbackMetadata?: {
        Item: Array<{
          Name: string;
          Value: string | number;
        }>;
      };
    };
  };
}

/**
 * C2B Confirmation Callback
 * Sent after M-Pesa payment to a paybill/till number
 *
 * NOTE: this is a FLAT payload — it is NOT wrapped in Body.stkCallback, and it
 * carries no CheckoutRequestID/ResultCode/CallbackMetadata at all. Safaricom only
 * sends a confirmation for a payment that already succeeded, so there is no result
 * code to inspect. This interface previously duplicated the STK shape above, which
 * meant nothing could ever parse a real C2B payload. `extractNaturalKey` and
 * `WebhookPollerService.processC2bConfirmation` both already read the flat fields —
 * this type now matches what they (and Safaricom) actually use.
 *
 * Example:
 * {
 *   "TransactionType": "Pay Bill",
 *   "TransID": "LHG31H5V60K0",
 *   "TransTime": "20231129133424",
 *   "TransAmount": "100.00",
 *   "BusinessShortCode": "600000",
 *   "BillRefNumber": "INV-1",
 *   "MSISDN": "254717123456",
 *   "FirstName": "Jane"
 * }
 */
export interface DarajaC2bCallback {
  TransactionType?: string;
  TransID: string;
  TransTime?: string | number;
  TransAmount?: string | number;
  BusinessShortCode?: string | number;
  BillRefNumber?: string;
  InvoiceNumber?: string;
  OrgAccountBalance?: string | number;
  ThirdPartyTransID?: string;
  MSISDN?: string | number;
  FirstName?: string;
  MiddleName?: string;
  LastName?: string;
}

/**
 * B2C Result Callback (posted to ResultURL)
 *
 * A THIRD payload shape, unrelated to both above: not wrapped in `Body.stkCallback`,
 * not flat like C2B, but wrapped in `Result` with its metadata under
 * `ResultParameters.ResultParameter` (note: `Key`/`Value`, where the STK callback
 * uses `Name`/`Value` — they are not interchangeable).
 *
 * `ResultCode: 0` here DOES mean the payout completed, unlike the sync response to
 * the payment request itself, where 0 only means "accepted into the queue."
 *
 * Example:
 * {
 *   "Result": {
 *     "ResultType": 0,
 *     "ResultCode": 0,
 *     "ResultDesc": "The service request is processed successfully.",
 *     "OriginatorConversationID": "8551-61996145-1",
 *     "ConversationID": "AG_20260829_0000abc",
 *     "TransactionID": "LGR019G3J2",
 *     "ResultParameters": {
 *       "ResultParameter": [
 *         { "Key": "TransactionAmount", "Value": 500 },
 *         { "Key": "TransactionReceipt", "Value": "LGR019G3J2" },
 *         { "Key": "ReceiverPartyPublicName", "Value": "254712345678 - John Doe" },
 *         { "Key": "TransactionCompletedDateTime", "Value": "29.08.2026 10:00:00" }
 *       ]
 *     }
 *   }
 * }
 */
export interface DarajaB2cResultCallback {
  Result: {
    ResultType?: number;
    ResultCode: number;
    ResultDesc: string;
    OriginatorConversationID: string;
    ConversationID?: string;
    TransactionID?: string;
    ResultParameters?: {
      ResultParameter: Array<{
        Key: string;
        Value: string | number;
      }>;
    };
  };
}

/**
 * B2C Queue Timeout Callback (posted to QueueTimeOutURL)
 *
 * Same `Result` envelope, but it means something entirely different and much more
 * dangerous: Safaricom could not process the request within its queue window. It is
 * NOT a failure notice — the payout may still complete, with the real result arriving
 * at ResultURL afterwards. Treating this as a failure and releasing the tenant's
 * reservation is how the same shillings get spent twice.
 */
export type DarajaB2cTimeoutCallback = DarajaB2cResultCallback;

/**
 * Every `source` value WebhookEvent's (source, naturalKey) idempotency key accepts.
 * Distinct sources are distinct namespaces, so a B2C key can never collide with an
 * STK one even if the strings were identical.
 */
export type WebhookSource =
  | "daraja_stk_callback"
  | "daraja_c2b_confirmation"
  | "daraja_b2c_result"
  | "daraja_b2c_timeout";

/**
 * Extracted/normalized callback data
 * Use this internally (not Daraja's raw format)
 */
export interface NormalizedWebhookPayload {
  // Identifiers
  // Optional because only STK Push has one — a C2B confirmation is unsolicited by
  // definition (the customer initiated it on their handset), so there is no
  // checkout request for it to refer back to. It is keyed by mpesaReceiptNumber
  // (Daraja's TransID) instead.
  checkoutRequestId?: string;
  mpesaReceiptNumber?: string;

  // Status
  resultCode: number;
  resultDesc: string;
  success: boolean;

  // Payment details
  amount?: number;
  transactionDate?: Date;
  msisdn?: string;

  // Metadata
  callbackType: "stk_push" | "c2b";
  receivedAt: Date;
  rawPayload: unknown;
}

/**
 * Webhook Event (stored in database)
 */
export interface StoredWebhookEvent {
  id: string;
  source: "daraja_stk_callback" | "daraja_c2b_confirmation";
  naturalKey: string; // Unique identifier for idempotency
  status: "pending" | "processing" | "processed" | "failed";
  payload: unknown;
  error?: string;
  processedAt?: Date;
  createdAt: Date;
}
