import { describe, expect, it } from 'vitest';
import { zipBytes } from '../src/viewer/media/zip.ts';

describe('zipBytes', () => {
  it('starts with the local file header signature', () => {
    const bytes = zipBytes([{ name: 'a.csv', text: 'x' }]);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('ends with the end-of-central-directory signature', () => {
    const bytes = zipBytes([{ name: 'a.csv', text: 'x' }]);
    const tail = bytes.slice(-22, -18);
    expect(Array.from(tail)).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });

  it('records one central directory entry per file', () => {
    const bytes = zipBytes([
      { name: 'a.csv', text: 'x' },
      { name: 'b.csv', text: 'y' },
    ]);
    const count = new DataView(bytes.buffer).getUint16(bytes.length - 14, true);
    expect(count).toBe(2);
  });

  it('stores the content uncompressed and intact', () => {
    const bytes = zipBytes([{ name: 'a.csv', text: 'hello' }]);
    expect(new TextDecoder().decode(bytes).includes('hello')).toBe(true);
  });
});
