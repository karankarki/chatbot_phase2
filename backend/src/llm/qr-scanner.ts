import { Jimp } from 'jimp';
import jsQR from 'jsqr';

/**
 * Attempt to decode a QR code from a base64-encoded image.
 * Returns the decoded string, or null if no QR code was found.
 */
export async function scanQrFromBase64(base64: string): Promise<string | null> {
  try {
    const buffer = Buffer.from(base64, 'base64');
    const image = await Jimp.fromBuffer(buffer);
    for (const angle of [0, 90, 180, 270]) {
      const img = angle === 0 ? image.clone() : image.clone().rotate(angle);
      const { data, width, height } = img.bitmap;
      const code = jsQR(data as unknown as Uint8ClampedArray, width, height);
      if (code?.data) return code.data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the serial number from a QR code value.
 * The serial appears after the last '#' character.
 * Returns the extracted serial if it looks valid (15 chars, starts with D/M/T/0),
 * otherwise returns the raw value for the LLM to evaluate.
 */
export function extractSerialFromQr(qrValue: string): string | null {
  const hashIdx = qrValue.lastIndexOf('#');
  const candidate = hashIdx >= 0 ? qrValue.slice(hashIdx + 1).trim() : qrValue.trim();
  if (candidate.length >= 10 && candidate.length <= 16 && /^[DMT0]/i.test(candidate)) {
    return candidate;
  }
  return candidate.length > 0 ? candidate : null;
}
