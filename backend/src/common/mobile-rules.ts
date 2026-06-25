/**
 * Country-specific mobile number rules.
 * dialCode  — numeric country calling code (no +)
 * minLength — minimum local digits (after country code / leading 0 stripped)
 * maxLength — maximum local digits
 */
export interface MobileRule {
  dialCode: string;
  minLength: number;
  maxLength: number;
}

export const MOBILE_RULES: Record<string, MobileRule> = {
  // South Asia
  IN: { dialCode: '91',  minLength: 10, maxLength: 10 },
  PK: { dialCode: '92',  minLength: 10, maxLength: 10 },
  BD: { dialCode: '880', minLength: 10, maxLength: 10 },
  LK: { dialCode: '94',  minLength:  9, maxLength:  9 },
  NP: { dialCode: '977', minLength: 10, maxLength: 10 },
  // Middle East
  AE: { dialCode: '971', minLength:  9, maxLength:  9 },
  SA: { dialCode: '966', minLength:  9, maxLength:  9 },
  QA: { dialCode: '974', minLength:  8, maxLength:  8 },
  KW: { dialCode: '965', minLength:  8, maxLength:  8 },
  BH: { dialCode: '973', minLength:  8, maxLength:  8 },
  OM: { dialCode: '968', minLength:  8, maxLength:  8 },
  // Southeast Asia
  SG: { dialCode: '65',  minLength:  8, maxLength:  8 },
  MY: { dialCode: '60',  minLength:  9, maxLength: 10 },
  ID: { dialCode: '62',  minLength:  9, maxLength: 12 },
  PH: { dialCode: '63',  minLength: 10, maxLength: 10 },
  TH: { dialCode: '66',  minLength:  9, maxLength:  9 },
  VN: { dialCode: '84',  minLength:  9, maxLength: 10 },
  // North America
  US: { dialCode: '1',   minLength: 10, maxLength: 10 },
  CA: { dialCode: '1',   minLength: 10, maxLength: 10 },
  // Europe
  GB: { dialCode: '44',  minLength: 10, maxLength: 10 },
  DE: { dialCode: '49',  minLength: 10, maxLength: 11 },
  FR: { dialCode: '33',  minLength:  9, maxLength:  9 },
  // Africa
  ZA: { dialCode: '27',  minLength:  9, maxLength:  9 },
  NG: { dialCode: '234', minLength: 10, maxLength: 10 },
  // Oceania
  AU: { dialCode: '61',  minLength:  9, maxLength:  9 },
};

/** Fallback for unlisted countries — accept 7–15 local digits */
export const DEFAULT_MOBILE_RULE: MobileRule = {
  dialCode: '',
  minLength: 7,
  maxLength: 15,
};

export function getMobileRule(countryCode?: string): MobileRule {
  if (!countryCode) return DEFAULT_MOBILE_RULE;
  return MOBILE_RULES[countryCode.toUpperCase()] ?? DEFAULT_MOBILE_RULE;
}
