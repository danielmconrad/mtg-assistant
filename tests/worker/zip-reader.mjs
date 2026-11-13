// Reads a ZIP from src/zip.mjs back into { path: text }, checking each entry's CRC and sizes, so the
// download tests read the archive as an unzip tool would.
import { crc32 } from '../../src/zip.mjs';

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error('no end of central directory');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = {};
  for (let entry = 0; entry < count; entry += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad central directory entry');
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (view.getUint32(offset, true) !== 0x04034b50) throw new Error(`${name}: bad local header`);
    const dataStart = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const data = await inflate(bytes.subarray(dataStart, dataStart + compressedSize));
    if (data.length !== size || crc32(data) !== crc) throw new Error(`${name}: size or CRC mismatch`);
    files[name] = new TextDecoder().decode(data);
    at += 46 + nameLength;
  }
  return files;
}
