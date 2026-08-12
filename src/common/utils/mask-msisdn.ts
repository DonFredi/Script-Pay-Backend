export function maskMsisdn(msisdn: string): string {
  // Hide middle digits: 254712345678 → 2547123*****

  return msisdn.length >= 8 ? `${msisdn.slice(0, 6)}****${msisdn.slice(-2)}` : "****";
}
