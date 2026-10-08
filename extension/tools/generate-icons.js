const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const sizes = [16, 32, 48, 128];
const outDir = path.resolve(__dirname, '../icons');

for (const size of sizes) {
  const png = createIcon(size);
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png);
}

function createIcon(size) {
  const width = size;
  const height = size;
  const data = Buffer.alloc(width * height * 4);
  const samples = size <= 32 ? 5 : 4;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const color = [0, 0, 0, 0];

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          const sample = sampleIcon(px, py, size);
          color[0] += sample[0];
          color[1] += sample[1];
          color[2] += sample[2];
          color[3] += sample[3];
        }
      }

      const total = samples * samples;
      setPixel(
        data,
        index,
        Math.round(color[0] / total),
        Math.round(color[1] / total),
        Math.round(color[2] / total),
        Math.round(color[3] / total),
      );
    }
  }

  return encodePng(width, height, data);
}

function sampleIcon(x, y, size) {
  const shadow = roundedRectAt(x, y, size * 0.09, size * 0.09, size * 0.85, size * 0.85, size * 0.17);
  const face = roundedRectAt(x, y, size * 0.05, size * 0.04, size * 0.85, size * 0.85, size * 0.17);
  if (!shadow && !face) {
    return [0, 0, 0, 0];
  }

  let color = [221, 228, 238, 255];
  if (face) {
    color = tileColor(x, y, size);
  }
  if (softBlueWave(x, y, size)) {
    color = [226, 239, 255, 255];
  }
  if (arrowShadow(x, y, size)) {
    color = [150, 174, 210, 120];
  }
  if (undoArrow(x, y, size)) {
    color = arrowColor(x, y, size);
  }
  const chrome = chromeCorner(x, y, size);
  if (chrome) {
    color = chrome;
  }
  return color;
}

function tileColor(x, y, size) {
  const nx = x / size;
  const ny = y / size;
  const white = radial(nx, ny, 0.26, 0.18, 0.7);
  const shade = radial(nx, ny, 0.86, 0.90, 0.9);
  const base = [
    246 + white * 8 - shade * 8,
    248 + white * 7 - shade * 9,
    252 + white * 3 - shade * 6,
  ];
  return base.map((value) => Math.max(0, Math.min(255, Math.round(value)))).concat(255);
}

function radial(x, y, cx, cy, radius) {
  const distance = Math.hypot(x - cx, y - cy);
  return Math.max(0, 1 - distance / radius);
}

function roundedRectAt(x, y, left, top, width, height, radius) {
  return roundedRect(x - left, y - top, width, height, radius);
}

function roundedRect(x, y, width, height, radius) {
  const left = radius;
  const right = width - radius - 1;
  const top = radius;
  const bottom = height - radius - 1;
  const insideBody = (x >= left && x <= right && y >= 0 && y < height)
    || (y >= top && y <= bottom && x >= 0 && x < width);
  if (insideBody) {
    return true;
  }
  const cx = x < left ? left : right;
  const cy = y < top ? top : bottom;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function softBlueWave(x, y, size) {
  const leftWave = Math.hypot(x - size * 0.01, y - size * 0.74) <= size * 0.27;
  const bottomWave = Math.hypot(x - size * 0.35, y - size * 1.03) <= size * 0.43;
  return leftWave || bottomWave;
}

function arrowShadow(x, y, size) {
  return undoArrow(x - size * 0.025, y - size * 0.035, size);
}

function undoArrow(x, y, size) {
  const stroke = Math.max(2.4, size * 0.105);
  const center = { x: size * 0.55, y: size * 0.50 };
  const radius = size * 0.24;
  const head = { x: size * 0.32, y: size * 0.32 };
  const shaftEnd = { x: size * 0.58, y: size * 0.32 };
  const dotOne = Math.hypot(x - size * 0.27, y - size * 0.64) <= stroke * 0.53;
  const dotTwo = Math.hypot(x - size * 0.38, y - size * 0.64) <= stroke * 0.53;

  const top = distanceToSegment(x, y, head.x, head.y, shaftEnd.x, shaftEnd.y) <= stroke / 2;
  const headUpper = distanceToSegment(x, y, head.x, head.y, size * 0.45, size * 0.18) <= stroke / 2;
  const headLower = distanceToSegment(x, y, head.x, head.y, size * 0.45, size * 0.46) <= stroke / 2;
  const dx = x - center.x;
  const dy = y - center.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  let angle = Math.atan2(dy, dx);
  if (angle < 0) {
    angle += Math.PI * 2;
  }
  const curve = distance >= radius - stroke / 2
    && distance <= radius + stroke / 2
    && angle >= Math.PI * 0.0
    && angle <= Math.PI * 1.55;
  return top || curve || headUpper || headLower || dotOne || dotTwo;
}

function arrowColor(x, y, size) {
  const blend = Math.max(0, Math.min(1, (x + y) / (size * 1.5)));
  return [
    Math.round(18 + blend * 20),
    Math.round(135 - blend * 55),
    Math.round(255 - blend * 8),
    255,
  ];
}

function chromeCorner(x, y, size) {
  const cx = size * 0.84;
  const cy = size * 0.84;
  const radius = size * 0.25;
  const distance = Math.hypot(x - cx, y - cy);
  if (distance > radius) {
    return null;
  }
  const angle = Math.atan2(y - cy, x - cx);
  if (distance < radius * 0.36) {
    return [54, 126, 245, 255];
  }
  if (distance < radius * 0.52) {
    return [248, 250, 255, 255];
  }
  if (angle < -0.8) {
    return [255, 211, 58, 255];
  }
  if (angle < 1.25) {
    return [66, 133, 244, 255];
  }
  if (angle < 2.85) {
    return [26, 170, 86, 255];
  }
  return [234, 67, 53, 255];
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(px - x1, py - y1);
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function setPixel(data, index, r, g, b, a) {
  data[index] = r;
  data[index + 1] = g;
  data[index + 2] = b;
  data[index + 3] = a;
}

function encodePng(width, height, rgba) {
  const rowLength = width * 4;
  const raw = Buffer.alloc((rowLength + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (rowLength + 1)] = 0;
    rgba.copy(raw, y * (rowLength + 1) + 1, y * rowLength, (y + 1) * rowLength);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0]),
    ])),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  return Buffer.concat([
    uint32(data.length),
    typeBuffer,
    data,
    uint32(crc32(Buffer.concat([typeBuffer, data]))),
  ]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
