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
 * Example:
 * {
 *   "Body": {
 *     "stkCallback": {
 *       "CheckoutRequestID": "...",
 *       "ResultCode": 0,
 *       "ResultDesc": "...",
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
export interface DarajaC2bCallback {
  Body: {
    stkCallback: {
      CheckoutRequestID: string;
      ResultCode: number;
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
 * Extracted/normalized callback data
 * Use this internally (not Daraja's raw format)
 */
export interface NormalizedWebhookPayload {
  // Identifiers
  checkoutRequestId: string;
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
