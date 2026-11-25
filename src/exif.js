'use strict'

// WhatsApp sticker EXIF TIFF header (22 bytes).
// Bytes 14..17 hold the little-endian uint32 byte length of the trailing UTF-8 JSON payload.
const WA_EXIF_HEADER = Buffer.from([
  0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
])

const VP8X_EXIF_FLAG = 0x08

function buildStickerExif({ pack, author, packId, emojis = [''] }) {
  const metadata = {
    'sticker-pack-id': packId || 'com.whatsapp.soundsticker',
    'sticker-pack-name': pack || '',
    'sticker-pack-publisher': author || '',
    emojis,
  }
  const jsonBuf = Buffer.from(JSON.stringify(metadata), 'utf8')
  const header = Buffer.from(WA_EXIF_HEADER)
  header.writeUInt32LE(jsonBuf.length, 14)
  return Buffer.concat([header, jsonBuf])
}

function buildRiffChunk(fourcc, payload) {
  const header = Buffer.alloc(8)
  header.write(fourcc, 0, 4, 'ascii')
  header.writeUInt32LE(payload.length, 4)
  const pad = payload.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0)
  return Buffer.concat([header, payload, pad])
}

function buildVp8xChunk({ width, height, hasAlpha = false, hasAnim = false, hasExif = true }) {
  const payload = Buffer.alloc(10)
  let flags = 0
  if (hasExif) flags |= VP8X_EXIF_FLAG
  if (hasAlpha) flags |= 0x10
  if (hasAnim) flags |= 0x02
  payload[0] = flags

  const w = Math.max(1, width) - 1
  const h = Math.max(1, height) - 1
  payload.writeUIntLE(w, 4, 3)
  payload.writeUIntLE(h, 7, 3)
  return buildRiffChunk('VP8X', payload)
}

/**
 * Injects or replaces the EXIF chunk in a WebP buffer without external tools (webpmux/python).
 * Animated WebP files produced by ffmpeg's libwebp_anim always start with a VP8X chunk;
 * simple VP8/VP8L buffers are also promoted to VP8X when width/height are provided.
 */
function injectWebpExif(webpBuf, exifPayload, { width = 512, height = 512 } = {}) {
  if (
    !Buffer.isBuffer(webpBuf) ||
    webpBuf.length < 12 ||
    webpBuf.toString('ascii', 0, 4) !== 'RIFF' ||
    webpBuf.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new Error('Invalid WebP buffer: missing RIFF/WEBP header')
  }

  const chunks = []
  let hasVp8x = false
  let hasAlpha = false
  let hasAnim = false
  let offset = 12

  while (offset + 8 <= webpBuf.length) {
    const fourcc = webpBuf.toString('ascii', offset, offset + 4)
    const size = webpBuf.readUInt32LE(offset + 4)
    const dataStart = offset + 8
    const dataEnd = dataStart + size
    if (dataEnd > webpBuf.length) {
      throw new Error(`Truncated WebP chunk "${fourcc}" at offset ${offset}`)
    }

    const paddedEnd = dataEnd + (size % 2)
    if (fourcc !== 'EXIF') {
      const payload = Buffer.from(webpBuf.subarray(dataStart, dataEnd))
      if (fourcc === 'VP8X') {
        if (payload.length < 10) throw new Error('Malformed VP8X chunk')
        payload[0] |= VP8X_EXIF_FLAG
        hasVp8x = true
      } else if (fourcc === 'ALPH') {
        hasAlpha = true
      } else if (fourcc === 'ANIM') {
        hasAnim = true
      }
      chunks.push(buildRiffChunk(fourcc, payload))
    }

    offset = paddedEnd
  }

  if (!hasVp8x) {
    chunks.unshift(buildVp8xChunk({ width, height, hasAlpha, hasAnim, hasExif: true }))
  }

  chunks.push(buildRiffChunk('EXIF', exifPayload))

  const body = Buffer.concat(chunks)
  const riffHeader = Buffer.alloc(12)
  riffHeader.write('RIFF', 0, 4, 'ascii')
  riffHeader.writeUInt32LE(4 + body.length, 4)
  riffHeader.write('WEBP', 8, 4, 'ascii')

  return Buffer.concat([riffHeader, body])
}

module.exports = { buildStickerExif, injectWebpExif }
