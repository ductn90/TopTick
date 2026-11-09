/**
 * Generates the app and tray icons with a tiny pure-Node PNG encoder (zlib only).
 *
 *   npm run gen-icons
 *
 * The glyph is the user-provided Graph Up icon v3 (user-icon-graph-up-v3.svg, chosen by the user
 * on 2026-11-06): a solid rounded square with the up-graph arrow cut out (fill-rule evenodd)
 * that fills the whole 24x24 viewBox. It is rasterized from the SVG path data below with
 * signed-distance anti-aliasing. Because v3 has no margin, the tray icons draw it inset by
 * 2/24 on each side (A20), the same visible size as the earlier Solar bold glyph. The app
 * icons are full bleed (no margin, D16).
 *
 * build/icon.png            1024x1024 app icon, full bleed (D16): the v3 rounded square in #16C784
 *                           fills the canvas edge to edge, the arrow is #0B0D12 (not a hole),
 *                           the corners are transparent; electron-builder makes the macOS .icns
 * build/icon.ico            Windows app icon (16/32/48/256 px PNGs in an ICO container)
 * build/trayTemplate.png    16x16 macOS template image (black glyph + alpha; the cut-out is clear)
 * build/trayTemplate@2x.png 32x32
 * build/tray.ico            Windows tray icon (16 + 32 px): glyph filled #16C784, cut-out clear,
 *                           so the taskbar shows through on light and dark taskbars
 */
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')

// ---------- PNG encoding ----------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** RGBA8 pixels (Uint8Array, size*size*4) -> PNG file bytes. */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // no interlace
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter type None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** ICO container with embedded PNG images (Vista+). */
function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + 16 * images.length
  for (const { size, png } of images) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e[2] = 0 // palette colors
    e[3] = 0 // reserved
    e.writeUInt16LE(1, 4) // color planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

// ---------- Drawing (signed distances, 1 px anti-aliasing) ----------

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

function segmentDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// ---------- SVG path flattening (M/m L/l H/h V/v C/c S/s Z/z) ----------

/** Graph Up v3 (user-icon-graph-up-v3.svg), viewBox 0 0 24 24, fill-rule evenodd, full bleed. */
const GRAPH_UP_V3 =
  'M1.76,1.76C0,3.51,0,6.34,0,12s0,8.49,1.76,10.24c1.76,1.76,4.59,1.76,10.24,1.76s8.49,0,10.24-1.76c1.76-1.76,1.76-4.59,1.76-10.24s0-8.49-1.76-10.24C20.49,0,17.66,0,12,0S3.51,0,1.76,1.76ZM14.1,9.6c0,.5.4.9.9.9h.83l-2.41,2.42c-.12.12-.31.12-.42,0l-1.9-1.9c-.82-.82-2.15-.82-2.97,0l-2.75,2.75c-.35.35-.35.92,0,1.27s.92.35,1.27,0l2.75-2.75c.12-.12.31-.12.42,0l1.9,1.9c.82.82,2.15.82,2.97,0l2.42-2.41v.83c0,.5.4.9.9.9s.9-.4.9-.9v-3c0-.5-.4-.9-.9-.9h-3c-.5,0-.9.4-.9.9Z'

/** Padding added around the full-bleed v3 glyph, in 24-unit grid units per side (A20). */
const GLYPH_MARGIN = 2

/** Returns closed polygons (arrays of [x, y]) for an SVG path string. */
function flattenPath(d, curveSegments = 24) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g)
  const polys = []
  let poly = null
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  let lastC2 = null // second control point of the previous cubic (for S/s)
  let cmd = null
  let i = 0
  const num = () => Number(tokens[i++])
  const isNum = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i])
  const cubic = (x1, y1, x2, y2, ex, ey) => {
    for (let k = 1; k <= curveSegments; k++) {
      const t = k / curveSegments
      const u = 1 - t
      poly.push([
        u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex,
        u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey
      ])
    }
    lastC2 = [x2, y2]
    x = ex
    y = ey
  }
  while (i < tokens.length) {
    if (!isNum()) cmd = tokens[i++]
    const rel = cmd === cmd.toLowerCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    const c = cmd.toLowerCase()
    if (c !== 'c' && c !== 's') lastC2 = null
    switch (c) {
      case 'm':
        x = sx = num() + ox
        y = sy = num() + oy
        poly = [[x, y]]
        polys.push(poly)
        cmd = rel ? 'l' : 'L' // implicit lineto after moveto
        break
      case 'l':
        x = num() + ox
        y = num() + oy
        poly.push([x, y])
        break
      case 'h':
        x = num() + ox
        poly.push([x, y])
        break
      case 'v':
        y = num() + oy
        poly.push([x, y])
        break
      case 'c': {
        const v = [num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy]
        cubic(...v)
        break
      }
      case 's': {
        const [x1, y1] = lastC2 ? [2 * x - lastC2[0], 2 * y - lastC2[1]] : [x, y]
        cubic(x1, y1, num() + ox, num() + oy, num() + ox, num() + oy)
        break
      }
      case 'z':
        poly.push([sx, sy])
        x = sx
        y = sy
        break
      default:
        throw new Error(`unsupported path command ${cmd}`)
    }
  }
  return polys
}

function edgesDist(px, py, polys) {
  let d = Infinity
  for (const pts of polys) {
    for (let k = 0; k < pts.length - 1; k++) d = Math.min(d, segmentDist(px, py, pts[k], pts[k + 1]))
  }
  return d
}

/** Even-odd fill rule over all subpaths. */
function insideEvenOdd(px, py, polys) {
  let c = false
  for (const pts of polys) {
    for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) {
      const [xi, yi] = pts[k]
      const [xj, yj] = pts[j]
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c
    }
  }
  return c
}

const coverage = (signedDist) => Math.max(0, Math.min(1, 0.5 - signedDist))

/** Composite `color` with alpha `a` (0..1) over the pixel at index i. */
function blend(buf, i, [r, g, b], a) {
  if (a <= 0) return
  const da = buf[i + 3] / 255
  const oa = a + da * (1 - a)
  const mix = (src, dst) => Math.round((src * a + dst * da * (1 - a)) / oa)
  buf[i] = mix(r, buf[i])
  buf[i + 1] = mix(g, buf[i + 1])
  buf[i + 2] = mix(b, buf[i + 2])
  buf[i + 3] = Math.round(oa * 255)
}

/** The v3 polygons scaled onto a `size` px square, inset by `margin` grid units per side. */
function glyphPolys(size, margin) {
  const k = size / 24
  const scale = (24 - 2 * margin) / 24
  const map = (v) => (margin + v * scale) * k
  return flattenPath(GRAPH_UP_V3).map((pts) => pts.map(([x, y]) => [map(x), map(y)]))
}

/** Glyph filled with `fill` (even-odd: the arrow is transparent), inset by GLYPH_MARGIN. */
function drawGlyph(size, fill) {
  const buf = new Uint8Array(size * size * 4)
  const polys = glyphPolys(size, GLYPH_MARGIN)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const d = edgesDist(px, py, polys)
      blend(buf, (y * size + x) * 4, fill, coverage(insideEvenOdd(px, py, polys) ? -d : d))
    }
  }
  return encodePng(size, buf)
}

/**
 * Full-bleed app icon: the outer rounded square (first subpath) in `fill` covering the whole
 * canvas, the arrow (second subpath) painted `arrow` instead of cut out.
 */
function drawFullBleed(size, fill, arrow) {
  const buf = new Uint8Array(size * size * 4)
  const [outer, ...inner] = glyphPolys(size, 0)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const i = (y * size + x) * 4
      const dOut = edgesDist(px, py, [outer])
      const shape = coverage(insideEvenOdd(px, py, [outer]) ? -dOut : dOut)
      if (shape <= 0) continue
      const dIn = edgesDist(px, py, inner)
      const a = coverage(insideEvenOdd(px, py, inner) ? -dIn : dIn)
      const c = fill.map((v, n) => Math.round(v * (1 - a) + arrow[n] * a))
      blend(buf, i, c, shape)
    }
  }
  return encodePng(size, buf)
}

const DARK = hex('#0B0D12') // --surface-0-base (dark): the arrow, as in the earlier icon
const UP = hex('#16C784') // --up (dark)

/** App icon, full bleed with no margin (D16, user decision 2026-11-06). */
const appIcon = (size) => drawFullBleed(size, UP, DARK)

/** Glyph on the full image; with the 2-unit margin it spans 20/24 of it (13.3 of 16 px). */
const glyphOnly = (size, fill) => drawGlyph(size, fill)

fs.mkdirSync(OUT, { recursive: true })
const files = {
  'icon.png': appIcon(1024),
  'icon.ico': encodeIco([16, 32, 48, 256].map((size) => ({ size, png: appIcon(size) }))),
  'trayTemplate.png': glyphOnly(16, [0, 0, 0]),
  'trayTemplate@2x.png': glyphOnly(32, [0, 0, 0]),
  'tray.ico': encodeIco([
    { size: 16, png: glyphOnly(16, UP) },
    { size: 32, png: glyphOnly(32, UP) }
  ])
}
for (const [name, bytes] of Object.entries(files)) {
  fs.writeFileSync(join(OUT, name), bytes)
  console.log(`wrote build/${name} (${bytes.length} bytes)`)
}
