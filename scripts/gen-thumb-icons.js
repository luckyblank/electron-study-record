// One-off icon generator for Windows thumbar buttons.
// Renders 16x16 white-on-transparent monochrome PNGs in assets/thumb/.
// Uses 4x supersampling + box filter for smooth, anti-aliased edges at small size.
// Run with: node scripts/gen-thumb-icons.js

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const SIZE = 16
const SS = 4 // supersample factor → render at 64x64, downsample to 16x16
const HI = SIZE * SS
const OUT_DIR = path.join(__dirname, '..', 'assets', 'thumb')

// High-res alpha canvas (Float32 alpha per pixel, 0..1)
function makeHi() {
  return new Float32Array(HI * HI)
}

function setHi(buf, x, y, v = 1) {
  if (x < 0 || x >= HI || y < 0 || y >= HI) return
  buf[y * HI + x] = Math.max(buf[y * HI + x], v)
}

// Distance helpers for SDF-based smooth shapes

// Rounded rect via SDF: distance ≤ 0 inside
function fillRoundedRect(buf, x, y, w, h, r) {
  const x0 = Math.max(0, Math.floor(x))
  const x1 = Math.min(HI - 1, Math.ceil(x + w))
  const y0 = Math.max(0, Math.floor(y))
  const y1 = Math.min(HI - 1, Math.ceil(y + h))
  const cx0 = x + r, cx1 = x + w - r
  const cy0 = y + r, cy1 = y + h - r
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const sx = px + 0.5, sy = py + 0.5
      let dx = 0, dy = 0
      if (sx < cx0) dx = sx - cx0
      else if (sx > cx1) dx = sx - cx1
      if (sy < cy0) dy = sy - cy0
      else if (sy > cy1) dy = sy - cy1
      const d = Math.sqrt(dx * dx + dy * dy) - r
      if (d <= 0) setHi(buf, px, py, 1)
    }
  }
}

// Filled triangle via barycentric coords
function fillTriangle(buf, ax, ay, bx, by, cx, cy) {
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
  const maxX = Math.min(HI - 1, Math.ceil(Math.max(ax, bx, cx)))
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)))
  const maxY = Math.min(HI - 1, Math.ceil(Math.max(ay, by, cy)))
  const denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
  if (denom === 0) return
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const sx = px + 0.5, sy = py + 0.5
      const w1 = ((by - cy) * (sx - cx) + (cx - bx) * (sy - cy)) / denom
      const w2 = ((cy - ay) * (sx - cx) + (ax - cx) * (sy - cy)) / denom
      const w3 = 1 - w1 - w2
      if (w1 >= 0 && w2 >= 0 && w3 >= 0) setHi(buf, px, py, 1)
    }
  }
}

// Downsample HI→SIZE by averaging an SS×SS block
function downsample(hi) {
  const out = new Uint8Array(SIZE * SIZE)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let sum = 0
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          sum += hi[(y * SS + dy) * HI + (x * SS + dx)]
        }
      }
      out[y * SIZE + x] = Math.round((sum / (SS * SS)) * 255)
    }
  }
  return out
}

// === Glyphs, in HI (64×64) coordinates ===
// Visual frame: 8px hi-res padding (= 2px @16) → glyph box = 48×48 inside HI.
// PAD..(HI-PAD) = 8..56

const PAD = 8

function drawPlay(hi) {
  // Right-pointing isoceles triangle, optically centered (apex sits ~2px right of center
  // because triangles look right-shifted otherwise).
  const left = PAD + 6          // 14
  const right = HI - PAD - 4    // 52
  const top = PAD + 2           // 10
  const bot = HI - PAD - 2      // 54
  const midY = (top + bot) / 2
  fillTriangle(hi,
    left, top,
    left, bot,
    right, midY
  )
}

function drawPause(hi) {
  // Two rounded vertical bars, symmetric around horizontal center.
  // Bar width 12 hi-res (= 3 @16), height 40 (= 10 @16), gap 8 (= 2 @16).
  const barW = 12
  const barH = 40
  const gap = 8
  const totalW = barW * 2 + gap
  const x0 = (HI - totalW) / 2
  const y0 = (HI - barH) / 2
  const r = 4 // 1px @16 rounded corner
  fillRoundedRect(hi, x0, y0, barW, barH, r)
  fillRoundedRect(hi, x0 + barW + gap, y0, barW, barH, r)
}

function drawStop(hi) {
  // Centered rounded square. 40×40 hi-res (= 10 @16) with corner radius 6.
  const s = 40
  const r = 6
  const x = (HI - s) / 2
  const y = (HI - s) / 2
  fillRoundedRect(hi, x, y, s, s, r)
}

// === PNG encoder (8-bit gray + alpha) ===
function encodePNG(alphaMap) {
  const w = SIZE, h = SIZE
  const rowBytes = 1 + w * 2
  const raw = Buffer.alloc(rowBytes * h)
  for (let y = 0; y < h; y++) {
    const off = y * rowBytes
    raw[off] = 0 // filter: None
    for (let x = 0; x < w; x++) {
      const a = alphaMap[y * w + x]
      raw[off + 1 + x * 2] = 255              // gray (white)
      raw[off + 1 + x * 2 + 1] = a            // alpha
    }
  }
  const compressed = zlib.deflateSync(raw)

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const typeBuf = Buffer.from(type, 'ascii')
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
    return Buffer.concat([len, typeBuf, data, crcBuf])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 4; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))])
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0
  return (c ^ 0xffffffff) >>> 0
}

function build(name, drawer) {
  const hi = makeHi()
  drawer(hi)
  const alpha = downsample(hi)
  const png = encodePNG(alpha)
  const out = path.join(OUT_DIR, `${name}.png`)
  fs.writeFileSync(out, png)
  console.log(`wrote ${out} (${png.length} bytes)`)
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })
build('play', drawPlay)
build('pause', drawPause)
build('stop', drawStop)
