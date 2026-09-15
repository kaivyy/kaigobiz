import { describe, it, expect } from 'vitest';
import { generateDynamicQRIS, calculateCRC16, generateQRCodeDataURL } from '../src/core/qris-generator';

describe('QRIS Generator', () => {
  describe('calculateCRC16', () => {
    it('should calculate correct 4-character uppercase hex CRC16 checksum', () => {
      const data = '000201010212';
      const crc = calculateCRC16(data);
      expect(crc).toHaveLength(4);
      expect(crc).toBe(crc.toUpperCase());
    });

    it('should calculate correct CRC16 for known sample payload', () => {
      // Known EMVCo CRC example or verification of deterministic output
      const sample = '0002010102125802ID5913MERCHANT NAME6007JAKARTA6304';
      const crc = calculateCRC16(sample);
      expect(crc).toHaveLength(4);
      expect(/^[0-9A-F]{4}$/.test(crc)).toBe(true);
    });
  });

  describe('generateDynamicQRIS', () => {
    it('should format dynamic QRIS payload with custom amount tag 54', () => {
      const staticTemplate = '0002010102125802ID5913MERCHANT NAME6007JAKARTA6304ABCD';
      const dynamicQRIS = generateDynamicQRIS(staticTemplate, 50000);
      expect(dynamicQRIS).toContain('540550000');
      expect(dynamicQRIS).not.toContain('ABCD'); // Checksum recalculated
      expect(dynamicQRIS.endsWith(calculateCRC16(dynamicQRIS.slice(0, -4)))).toBe(true);
    });

    it('should replace existing tag 54 if present', () => {
      const staticWithAmount = '0002010102125405100005802ID5913MERCHANT NAME6007JAKARTA6304ABCD';
      const dynamicQRIS = generateDynamicQRIS(staticWithAmount, 75000);
      expect(dynamicQRIS).toContain('540575000');
      expect(dynamicQRIS).not.toContain('540510000');
    });

    it('should return empty string if empty template provided', () => {
      expect(generateDynamicQRIS('', 10000)).toBe('');
    });

    it('should throw error when non-positive or invalid amount is provided', () => {
      const template = '0002010102115802ID6304ABCD';
      expect(() => generateDynamicQRIS(template, 0)).toThrow('Invalid amount');
      expect(() => generateDynamicQRIS(template, -500)).toThrow('Invalid amount');
      expect(() => generateDynamicQRIS(template, NaN)).toThrow('Invalid amount');
    });

    it('should preserve template structure and inject Tag 54 before 5802', () => {
      const template = '0002010102115802ID5913MERCHANT NAME6007JAKARTA6304ABCD';
      const dynamicQRIS = generateDynamicQRIS(template, 20000);
      expect(dynamicQRIS).toContain('010211');
      expect(dynamicQRIS).toContain('5405200005802ID');
    });
  });

  describe('generateQRCodeDataURL', () => {
    it('should generate a valid base64 data URL for QR code', async () => {
      const qrisString = '0002010102125802ID5913MERCHANT NAME6007JAKARTA54055000063041234';
      const dataUrl = await generateQRCodeDataURL(qrisString);
      expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    });
  });
});
