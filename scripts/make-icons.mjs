/**
 * Renders the toolbar icons from the brand mark.
 *
 *   node extension/scripts/make-icons.mjs
 *
 * Reads public/parallax/logo-mark.webp and writes public/icons/icon-{16,32,
 * 48,128}.png, which the build copies to the root of the bundle where manifest.json
 * points. Committed output, run by hand: the mark changes about once a year, and a
 * build step that shells out to sharp for four small files is not worth the coupling.
 *
 * Three decisions came out of looking at the source mark first (144x146, RGBA, and the
 * art runs edge to edge — an alpha bounding box of the full canvas):
 *
 *  1. It gets a ground rather than riding on transparency. The mark is gilt line work
 *     with a near-black hood: on Chrome's dark toolbar the hood and the eyes vanish,
 *     and the thin outer ring is the only thing left. A near-black plate (#0b0d0a, the
 *     app's `ink`) keeps the same icon on both light and dark toolbars, and it is the
 *     surface the mark is drawn against everywhere else in the product.
 *
 *  2. The plate is rounded and the mark is inset ~11% per side. The mark's ring touches
 *     the canvas edge, so drawn full-bleed on a rounded plate the corners would clip it
 *     and the circle would read as broken. Inset, the ring clears the radius.
 *
 *  3. A faint gilt hairline traces the plate. Near-black on Chrome's dark toolbar
 *     (~#292a2d) is a dark square on a slightly-less-dark bar; the hairline gives it an
 *     edge without turning the icon into a badge. It is scaled with the icon and stays
 *     under a pixel of visual weight at 16px.
 */
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const SOURCE = path.join(repoRoot, 'public/parallax/logo-mark.webp')
const OUT_DIR = path.join(repoRoot, 'public/icons')

/** The sizes Chrome asks for: 16 in the toolbar, 32 on Windows, 48 in the extensions
 *  page, 128 in the store listing and the install prompt. */
const SIZES = [16, 32, 48, 128]

const INK = '#0b0d0a'
const GILT = '#cdb360'

/** The rounded plate the mark sits on, as SVG so the corner radius is resolution
 *  independent — a scaled-up bitmap plate would soften the corners at 128. */
function plate(size) {
  const radius = Math.round(size * 0.22)
  const stroke = Math.max(0.75, size / 64)
  const inset = stroke / 2
  return Buffer.from(
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
       <rect x="${inset}" y="${inset}" width="${size - stroke}" height="${size - stroke}"
             rx="${radius}" ry="${radius}"
             fill="${INK}" stroke="${GILT}" stroke-opacity="0.28" stroke-width="${stroke}" />
     </svg>`,
  )
}

async function main() {
  const meta = await sharp(SOURCE).metadata()
  console.log(`source ${path.relative(repoRoot, SOURCE)} — ${meta.width}x${meta.height} ${meta.format}, alpha: ${meta.hasAlpha}`)

  await mkdir(OUT_DIR, { recursive: true })

  for (const size of SIZES) {
    // A proportional inset would round down to nothing at 16 and to a hair at 32, where
    // the mark needs every pixel it can get; a whole-pixel pad, floored at one, keeps the
    // ring clear of the plate's border at every size without starving the small ones.
    const pad = Math.max(1, Math.round(size * 0.09))
    const inner = size - pad * 2
    const offset = pad

    // `contain` on a transparent background, so the mark's own aspect ratio survives and
    // its transparency is carried into the composite rather than flattened early.
    const mark = await sharp(SOURCE)
      .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()

    const file = path.join(OUT_DIR, `icon-${size}.png`)
    await sharp(plate(size))
      .composite([{ input: mark, top: offset, left: offset }])
      .png({ compressionLevel: 9 })
      .toFile(file)

    const { size: bytes } = await stat(file)
    console.log(`wrote ${path.relative(repoRoot, file)} — ${size}x${size}, ${bytes} bytes`)
  }
}

await main()
