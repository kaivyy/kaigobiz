import QRCode from 'qrcode';

export interface TLV {
  tag: string;
  length: number;
  value: string;
}

export interface QRISDetails {
  isValid: boolean;
  isDynamic: boolean;
  merchantName?: string;
  merchantCity?: string;
  nmid?: string;
  mcc?: string;
  amount?: number;
}

/**
 * Calculates EMVCo CRC16 CCITT checksum (0x1021 polynomial, 0xFFFF initial value).
 * Returns a 4-character uppercase hexadecimal string.
 */
export function calculateCRC16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return (crc & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Parses TLV (Tag-Length-Value) encoded QRIS string.
 */
export function parseTLV(payload: string): TLV[] {
  const items: TLV[] = [];
  let index = 0;
  while (index < payload.length) {
    if (index + 4 > payload.length) break;
    const tag = payload.substring(index, index + 2);
    const lenStr = payload.substring(index + 2, index + 4);
    const length = parseInt(lenStr, 10);
    if (isNaN(length) || index + 4 + length > payload.length) {
      break;
    }
    const value = payload.substring(index + 4, index + 4 + length);
    items.push({ tag, length, value });
    index += 4 + length;
  }
  return items;
}

/**
 * Inspects QRIS string and extracts metadata (Merchant Name, City, NMID, Amount).
 */
export function inspectQRIS(qrisString: string): QRISDetails {
  if (!qrisString || !qrisString.trim()) {
    return { isValid: false, isDynamic: false };
  }

  const clean = qrisString.trim();
  const items = parseTLV(clean);
  if (items.length < 5) {
    return { isValid: false, isDynamic: false };
  }

  const tag01 = items.find((i) => i.tag === '01');
  const tag52 = items.find((i) => i.tag === '52');
  const tag54 = items.find((i) => i.tag === '54');
  const tag59 = items.find((i) => i.tag === '59');
  const tag60 = items.find((i) => i.tag === '60');
  const tag51 = items.find((i) => i.tag === '51');

  let nmid: string | undefined;
  if (tag51) {
    const subItems = parseTLV(tag51.value);
    const nmidSub = subItems.find((s) => s.tag === '02');
    if (nmidSub) nmid = nmidSub.value;
  }

  return {
    isValid: true,
    isDynamic: tag01?.value === '12',
    merchantName: tag59?.value,
    merchantCity: tag60?.value,
    nmid,
    mcc: tag52?.value,
    amount: tag54 ? Number(tag54.value) : undefined,
  };
}

/**
 * Generates a dynamic QRIS string by embedding/updating Tag 54 (Amount),
 * preserving static Tag 01 ('11'), and recalculating EMVCo CRC16 checksum (Tag 63).
 */
export function generateDynamicQRIS(staticTemplate: string, amount: number): string {
  if (!staticTemplate || !staticTemplate.trim()) {
    return '';
  }

  const numericAmount = Number(amount);
  if (isNaN(numericAmount) || numericAmount <= 0 || !isFinite(numericAmount)) {
    throw new Error('Invalid amount: must be a positive number');
  }

  const raw = staticTemplate.trim();
  const items = parseTLV(raw);
  if (items.length < 3) {
    return '';
  }

  // Filter out any existing CRC tag (Tag 63)
  const tags = items.filter((i) => i.tag !== '63');

  const amountStr = Math.round(numericAmount).toString();
  const tag54Obj = {
    tag: '54',
    length: amountStr.length,
    value: amountStr,
  };

  const existing54Idx = tags.findIndex((i) => i.tag === '54');
  if (existing54Idx !== -1) {
    tags[existing54Idx] = tag54Obj;
  } else {
    // Insert tag 54 right before country code tag 58 (5802ID) as per ASPI standard
    const idx58 = tags.findIndex((i) => i.tag === '58');
    if (idx58 !== -1) {
      tags.splice(idx58, 0, tag54Obj);
    } else {
      tags.push(tag54Obj);
    }
  }

  let payload = '';
  for (const item of tags) {
    const lenStr = item.value.length.toString().padStart(2, '0');
    payload += `${item.tag}${lenStr}${item.value}`;
  }

  payload += '6304';
  const checksum = calculateCRC16(payload);
  return payload + checksum;
}

/**
 * Generates a base64 PNG Data URL for the given QRIS payload.
 */
export async function generateQRCodeDataURL(qrisString: string): Promise<string> {
  return await QRCode.toDataURL(qrisString, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 300,
  });
}
