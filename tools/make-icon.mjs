// Generates desktop/appicon.ico procedurally - no image library, no binary asset
// checked in by hand. Run: node tools/make-icon.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'desktop', 'appicon.ico')
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const SS = 4 // supersampling factor

const BG = [0x16, 0x1b, 0x22]
const EDGE = [0x30, 0x36, 0x3d]
const BARS = [
  { colour: [0xf8, 0x51, 0x49], width: 0.78 }, // red
  { colour: [0xd2, 0x99, 0x22], width: 0.56 }, // amber
  { colour: [0x3f, 0xb9, 0x50], width: 0.34 }, // green
]

/** Signed distance to a rounded rectangle, negative inside. */
function roundedRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius - x, 0, x - (right - radius))
  const cy = Math.max(top + radius - y, 0, y - (bottom - radius))
  return Math.hypot(cx, cy) - radius
}

function shade(x, y, s) {
  const inset = s * 0.02
  const outer = roundedRect(x, y, inset, inset, s - inset, s - inset, s * 0.22)
  if (outer > 0) return null

  // subtle lighter rim
  let colour = outer > -s * 0.035 ? EDGE : BG

  const padX = s * 0.17
  const barH = s * 0.135
  const gap = s * 0.075
  const totalH = BARS.length * barH + (BARS.length - 1) * gap
  let barTop = (s - totalH) / 2

  for (const bar of BARS) {
    const right = padX + (s - 2 * padX) * bar.width
    const d = roundedRect(x, y, padX, barTop, right, barTop + barH, barH / 2)
    if (d <= 0) colour = bar.colour
    barTop += barH + gap
  }

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
