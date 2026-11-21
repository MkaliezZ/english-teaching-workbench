import type { MaterialExtension } from '../shared/materials.js';

export function matchesMaterialHeader(extension: MaterialExtension, header: Buffer) {
  switch (extension) {
    case '.pdf': return header.toString('ascii', 0, 5) === '%PDF-';
    case '.docx':
    case '.pptx': return header.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    case '.png': return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case '.jpg':
    case '.jpeg': return header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case '.webp': return header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
    default: return header.length > 0;
  }
}
