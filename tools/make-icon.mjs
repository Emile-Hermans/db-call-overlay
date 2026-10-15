// Generates desktop/appicon.ico procedurally - no image library, no binary asset
// checked in by hand. Run: node tools/make-icon.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'desktop', 'appicon.ico')
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const SS = 4 // supersampling factor

// The Clicktrace mark, on the same 24-unit grid as ui/logo.svg: a violet tile,
// three staggered bars (a waterfall) and the cursor that started it.
const GRADIENT_FROM = [0x7c, 0x66, 0xff]
const GRADIENT_TO = [0x3e, 0x2b, 0xc4]
const WHITE = [0xff, 0xff, 0xff]
const BARS = [
  { x: 5, y: 5.5, w: 9, opacity: 1 },
  { x: 9, y: 10.5, w: 10, opacity: 0.8 },
  { x: 13, y: 15.5, w: 6, opacity: 0.6 },
]
const CURSOR = [
  [4.6, 12.4],
  [4.6, 20.8],
  [6.9, 18.6],
  [8.5, 21.9],
  [10.1, 21.1],
  [8.5, 17.9],
  [11.7, 17.9],
]

/** Signed distance to a rounded rectangle, negative inside. */
function roundedRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius - x, 0, x - (right - radius))
  const cy = Math.max(top + radius - y, 0, y - (bottom - radius))
  return Math.hypot(cx, cy) - radius
}

function inPolygon(x, y, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))

function shade(px, py, s) {
  // Work in the 24-unit design space.
  const x = (px / s) * 24
  const y = (py / s) * 24
  if (roundedRect(x, y, 0, 0, 24, 24, 6) > 0) return null

  let colour = mix(GRADIENT_FROM, GRADIENT_TO, (x + y) / 48)
  for (const bar of BARS) {
    if (roundedRect(x, y, bar.x, bar.y, bar.x + bar.w, bar.y + 3, 1.5) <= 0) colour = mix(colour, WHITE, bar.opacity)
  }
  if (inPolygon(x, y, CURSOR)) colour = WHITE
  return colour
}

/** One 32bpp bottom-up BMP (DIB) image, as an ICO expects it. */
function renderDib(s) {
  const pixels = Buffer.alloc(s * s * 4)

  for (let py = 0; py < s; py++) {
    for (let px = 0; px < s; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const colour = shade(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS, s)
          if (colour) {
            r += colour[0]
            g += colour[1]
            b += colour[2]
            a += 255
          }
        }
      }

      const samples = SS * SS
      // bottom-up rows
      const offset = ((s - 1 - py) * s + px) * 4
      const alpha = Math.round(a / samples)
      // premultiplied against nothing: keep straight colours, weight by coverage
      const covered = a > 0 ? a / 255 : 1
      pixels[offset + 0] = Math.round(b / covered)
      pixels[offset + 1] = Math.round(g / covered)
      pixels[offset + 2] = Math.round(r / covered)
      pixels[offset + 3] = alpha
    }
  }

  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(s, 4) // biWidth
  header.writeInt32LE(s * 2, 8) // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // BI_RGB

  const maskStride = Math.ceil(s / 8 / 4) * 4
  const mask = Buffer.alloc(maskStride * s) // all zero = fully opaque, alpha rules

  return Buffer.concat([header, pixels, mask])
}

const images = SIZES.map((s) => ({ size: s, data: renderDib(s) }))

const dir = Buffer.alloc(6 + images.length * 16)
dir.writeUInt16LE(0, 0)
dir.writeUInt16LE(1, 2) // type: icon
dir.writeUInt16LE(images.length, 4)

let offset = dir.length
images.forEach((image, i) => {
  const at = 6 + i * 16
  dir.writeUInt8(image.size >= 256 ? 0 : image.size, at + 0)
  dir.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1)
  dir.writeUInt8(0, at + 2) // palette
  dir.writeUInt8(0, at + 3)
  dir.writeUInt16LE(1, at + 4) // planes
  dir.writeUInt16LE(32, at + 6) // bit count
  dir.writeUInt32LE(image.data.length, at + 8)
  dir.writeUInt32LE(offset, at + 12)
  offset += image.data.length
})

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, Buffer.concat([dir, ...images.map((i) => i.data)]))
console.log(`wrote ${OUT} (${SIZES.join(', ')} px, ${(offset / 1024).toFixed(0)} KB)`)
