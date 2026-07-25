import QRCode from 'qrcode';

interface TLV {
  tag: string;
  length: number;
  value: string;
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
function parseTLV(payload: string): TLV[] {
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
 * Generates a dynamic QRIS string by embedding/updating Tag 54 (Amount),
 * setting Tag 01 to dynamic ('12'), and recalculating EMVCo CRC16 checksum (Tag 63).
 */
export function generateDynamicQRIS(staticTemplate: string, amount: number): string {
  if (!staticTemplate || !staticTemplate.trim()) {
    return '';
  }

  const items = parseTLV(staticTemplate.trim());
  if (items.length === 0) {
    return '';
  }

  // Remove existing CRC tag 63
  const filtered = items.filter(item => item.tag !== '63');

  // Update tag 01 (Point of Initiation Method) to '12' (dynamic) if present and '11'
  const tag01 = filtered.find(item => item.tag === '01');
  if (tag01) {
    tag01.value = '12';
    tag01.length = 2;
  }

  // Format Tag 54 (Transaction Amount)
  const amountStr = amount.toString();
  const amountTLV: TLV = {
    tag: '54',
    length: amountStr.length,
    value: amountStr,
  };

  const tag54Index = filtered.findIndex(item => item.tag === '54');
  if (tag54Index !== -1) {
    filtered[tag54Index] = amountTLV;
  } else {
    // Insert tag 54 before the first tag > '54'
    const insertIndex = filtered.findIndex(item => item.tag > '54');
    if (insertIndex !== -1) {
      filtered.splice(insertIndex, 0, amountTLV);
    } else {
      filtered.push(amountTLV);
    }
  }

  // Reconstruct payload up to 6304
  let rawPayload = '';
  for (const item of filtered) {
    const lenStr = item.value.length.toString().padStart(2, '0');
    rawPayload += item.tag + lenStr + item.value;
  }
  rawPayload += '6304';

  const crc = calculateCRC16(rawPayload);
  return rawPayload + crc;
}

/**
 * Generates a base64 PNG Data URL for the given QRIS payload.
 */
export async function generateQRCodeDataURL(qrisString: string): Promise<string> {
  return await QRCode.toDataURL(qrisString);
}
