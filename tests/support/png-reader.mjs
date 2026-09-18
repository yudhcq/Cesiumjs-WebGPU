/**
 * Minimal PNG reader for the contract suites (`层=契约`).
 *
 * The strongest available evidence that a frame was **presented** (not merely submitted) is what the
 * compositor puts on screen, and Playwright's `page.screenshot()` is exactly that. Decoding the PNG
 * needs an inflate and the five PNG filter types — both are small and `node:zlib` provides the inflate,
 * so this stays dependency-free (the same discipline as `tools/**`).
 *
 * Supports the subset Playwright emits: 8-bit greyscale/RGB/RGBA/greyscale-alpha, no interlace.
 */
import zlib from "node:zlib";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** @param {Buffer} buffer PNG bytes */
export function decodePng(buffer) {
  for (let index = 0; index < SIGNATURE.length; index += 1) {
    if (buffer[index] !== SIGNATURE[index]) throw new Error("decodePng: not a PNG (bad signature)");
  }
  let offset = 8;
  let header = null;
  const dataChunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === "IDAT") dataChunks.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (header === null) throw new Error("decodePng: missing IHDR");
  if (header.bitDepth !== 8) throw new Error(`decodePng: unsupported bit depth ${header.bitDepth}`);
  if (header.interlace !== 0) throw new Error("decodePng: interlaced images are not supported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  if (channels === undefined) throw new Error(`decodePng: unsupported colour type ${header.colorType}`);

  const inflated = zlib.inflateSync(Buffer.concat(dataChunks));
  const stride = header.width * channels;
  const rgba = Buffer.alloc(header.width * header.height * 4);
  let previous = Buffer.alloc(stride);
  let cursor = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filterType = inflated[cursor];
    cursor += 1;
    const raw = Buffer.from(inflated.subarray(cursor, cursor + stride));
    cursor += stride;
    unfilter(filterType, raw, previous, channels);
    for (let x = 0; x < header.width; x += 1) {
      const source = x * channels;
      const target = (y * header.width + x) * 4;
      if (channels === 1) {
        rgba[target] = raw[source];
        rgba[target + 1] = raw[source];
        rgba[target + 2] = raw[source];
        rgba[target + 3] = 255;
      } else if (channels === 2) {
        rgba[target] = raw[source];
        rgba[target + 1] = raw[source];
        rgba[target + 2] = raw[source];
        rgba[target + 3] = raw[source + 1];
      } else if (channels === 3) {
        rgba[target] = raw[source];
        rgba[target + 1] = raw[source + 1];
        rgba[target + 2] = raw[source + 2];
        rgba[target + 3] = 255;
      } else {
        rgba[target] = raw[source];
        rgba[target + 1] = raw[source + 1];
        rgba[target + 2] = raw[source + 2];
        rgba[target + 3] = raw[source + 3];
      }
    }
    previous = raw;
  }
  return { width: header.width, height: header.height, rgba };
}

function unfilter(filterType, raw, previous, channels) {
  const stride = raw.length;
  for (let index = 0; index < stride; index += 1) {
    const left = index >= channels ? raw[index - channels] : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= channels ? previous[index - channels] ?? 0 : 0;
    switch (filterType) {
      case 0:
        break;
      case 1:
        raw[index] = (raw[index] + left) & 0xff;
        break;
      case 2:
        raw[index] = (raw[index] + up) & 0xff;
        break;
      case 3:
        raw[index] = (raw[index] + ((left + up) >> 1)) & 0xff;
        break;
      case 4: {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        raw[index] = (raw[index] + predictor) & 0xff;
        break;
      }
      default:
        throw new Error(`decodePng: unknown filter type ${filterType}`);
    }
  }
}

/** Statistics of one region: non-background pixel count, unique colours and the centre pixel. */
export function regionStatistics(image, region) {
  const { x, y, width, height } = region;
  let nonBackground = 0;
  let considered = 0;
  const colours = new Set();
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      const offset = (row * image.width + column) * 4;
      const r = image.rgba[offset];
      const g = image.rgba[offset + 1];
      const b = image.rgba[offset + 2];
      const a = image.rgba[offset + 3];
      considered += 1;
      if (a > 8 && r + g + b > 24) nonBackground += 1;
      if (colours.size < 256) colours.add(`${r},${g},${b},${a}`);
    }
  }
  const centreOffset = ((y + Math.floor(height / 2)) * image.width + (x + Math.floor(width / 2))) * 4;
  return {
    considered,
    nonBackground,
    uniqueColours: colours.size,
    centre: [image.rgba[centreOffset], image.rgba[centreOffset + 1], image.rgba[centreOffset + 2], image.rgba[centreOffset + 3]],
  };
}

/**
 * Sample individual pixels of a decoded image.
 *
 * `points` are **normalised** (`0..1`) coordinates, so a suite can name "the top-left quarter of the
 * left half" without knowing the screenshot's pixel size. Used by `visual:texture-origin` (the
 * four-corner texel assertion of T058) and by `contract:resources` (the two half-viewport probes).
 *
 * @param {{width: number, height: number, rgba: Buffer}} image
 * @param {{name: string, x: number, y: number}[]} points
 */
export function samplePixels(image, points) {
  return points.map((point) => {
    const x = Math.min(image.width - 1, Math.max(0, Math.round(point.x * (image.width - 1))));
    const y = Math.min(image.height - 1, Math.max(0, Math.round(point.y * (image.height - 1))));
    const offset = (y * image.width + x) * 4;
    return { name: point.name, x, y, rgba: [image.rgba[offset], image.rgba[offset + 1], image.rgba[offset + 2], image.rgba[offset + 3]] };
  });
}
