import { Injectable, Logger } from "@nestjs/common";

export interface TenantMpesaCredentials {
  mpesaConsumerKey: string;
  mpesaConsumerSecretEncrypted: string;
  mpesaPasskeyEncrypted: string;
  shortcode: string;
}

interface StkPushParams {
  amount: number;
  msisdn: string;
  accountReference: string;
  transactionDesc: string;
  transactionType: "CustomerPayBillOnline" | "CustomerBuyGoodsOnline";
}

interface StkPushResponse {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

@Injectable()
export class DarajaClient {
  private readonly logger = new Logger(DarajaClient.name);
  // Keyed by consumerKey — each tenant's credentials get their own cached token,
  // since tokens are only valid for the credentials that requested them.
  private tokenCache = new Map<string, CachedToken>();

  private get baseUrl(): string {
    return process.env.MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
  }

  private async getAccessToken(creds: TenantMpesaCredentials): Promise<string> {
    const now = Date.now();
    const cached = this.tokenCache.get(creds.mpesaConsumerKey);
    if (cached && cached.expiresAt > now) return cached.token;

    const credentials = Buffer.from(`${creds.mpesaConsumerKey}:${creds.mpesaConsumerSecretEncrypted}`).toString(
      "base64",
    );
    const response = await fetch(`${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      method: "GET",
      headers: { Authorization: `Basic ${credentials}` },
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(`Daraja OAuth token request failed: ${response.status} ${body}`);
      throw new Error("Failed to authenticate with Daraja using this tenant's credentials");
    }

    const data = (await response.json()) as { access_token: string; expires_in: string };
    const ttlMs = (Number(data.expires_in) - 60) * 1000;
    this.tokenCache.set(creds.mpesaConsumerKey, { token: data.access_token, expiresAt: now + ttlMs });
    return data.access_token;
  }

  private generatePassword(creds: TenantMpesaCredentials): { password: string; timestamp: string } {
    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14);
    const password = Buffer.from(`${creds.shortcode}${creds.mpesaPasskeyEncrypted}${timestamp}`).toString("base64");
    return { password, timestamp };
  }

  async initiateStkPush(creds: TenantMpesaCredentials, params: StkPushParams): Promise<StkPushResponse> {
    const accessToken = await this.getAccessToken(creds);
    const { password, timestamp } = this.generatePassword(creds);
    const callbackBaseUrl = process.env.MPESA_CALLBACK_BASE_URL;

    const response = await fetch(`${this.baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: creds.shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: params.transactionType,
        Amount: Math.round(params.amount),
        PartyA: params.msisdn,
        PartyB: creds.shortcode,
        PhoneNumber: params.msisdn,
        CallBackURL: `${callbackBaseUrl}/v1/webhooks/daraja/stk-callback`,
        AccountReference: params.accountReference,
        TransactionDesc: params.transactionDesc,
      }),
    });

    const body = await response.json();
    if (!response.ok || body.ResponseCode !== "0") {
      this.logger.error(`Daraja STK push rejected: ${JSON.stringify(body)}`);
      throw new Error(body.errorMessage ?? body.ResponseDescription ?? "Daraja rejected the STK push request");
    }

    return {
      MerchantRequestID: body.MerchantRequestID,
      CheckoutRequestID: body.CheckoutRequestID,
      ResponseCode: body.ResponseCode,
    };
  }

  async queryStkPushStatus(
    creds: TenantMpesaCredentials,
    checkoutRequestId: string,
  ): Promise<{ resultCode: number; resultDesc?: string }> {
    const accessToken = await this.getAccessToken(creds);
    const { password, timestamp } = this.generatePassword(creds);

    const response = await fetch(`${this.baseUrl}/mpesa/stkpushquery/v1/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: creds.shortcode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      }),
    });

    const body = await response.json();
    return { resultCode: Number(body.ResultCode ?? -1), resultDesc: body.ResultDesc };
  }
}
