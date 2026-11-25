'use strict'

const fs = require('fs')
const { execFile } = require('child_process')
const { injectWebpExif } = require('./exif')

// Canvas-size / quality / FPS ladder ordered roughly from largest to smallest output.
// Shrinking canvas at higher quality (e.g. 384 q=60) looks cleaner than 512 at low quality.
const WEBP_LADDER = [
  [512, 60, 15],
  [384, 60, 15],
  [320, 60, 15],
  [384, 45, 12],
  [320, 45, 12],
  [256, 45, 10],
  [320, 30, 10],
  [256, 30, 8],
  [256, 20, 8],
]

function runProcess(bin, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || '').trim()
        reject(new Error(`${bin} failed: ${detail}`))
        return
      }
      resolve(stdout)
    })
  })
}

async function probeMedia(filePath, ffprobeBin = 'ffprobe') {
  const out = await runProcess(ffprobeBin, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,width,height,duration',
    '-show_entries', 'format=duration',
    '-of', 'json',
    filePath,
  ])
  const parsed = JSON.parse(out)
  const streams = parsed.streams || []
  const hasAudio = streams.some((s) => s.codec_type === 'audio')
  const duration = parseFloat(parsed.format?.duration || '0')
  return { hasAudio, duration, streams }
}

async function videoToAnimatedWebp(inputPath, outputPath, options) {
  const {
    maxSeconds,
    maxBytes,
    exifPayload,
    ffmpegBin = 'ffmpeg',
    logPrefix = '[media]',
  } = options

  const trimArgs = maxSeconds > 0 ? ['-t', String(maxSeconds)] : []

  for (const [size, quality, fps] of WEBP_LADDER) {
    await runProcess(ffmpegBin, [
      '-y',
      '-v', 'error',
      '-i', inputPath,
      ...trimArgs,
      '-vf', `fps=${fps},scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`,
      '-loop', '0',
      '-c:v', 'libwebp_anim',
      '-lossless', '0',
      '-q:v', String(quality),
      '-preset', 'default',
      '-an',
      outputPath,
    ])

    const rawBuf = fs.readFileSync(outputPath)
    const stampedBuf = exifPayload
      ? injectWebpExif(rawBuf, exifPayload, { width: size, height: size })
      : rawBuf

    console.log(`${logPrefix} webp ${stampedBuf.length} bytes (${size}x${size} q=${quality} fps=${fps})`)
    if (stampedBuf.length <= maxBytes) {
      return { buffer: stampedBuf, size, quality, fps }
    }
  }

  throw new Error(`Converted WebP exceeds ${maxBytes} bytes even on lowest ladder rung`)
}

/**
 * Encodes audio to mono 32 kbps Ogg Opus in two passes (stereo 64k -> mono 32k)
 * for reliable playback compatibility on WhatsApp mobile clients.
 */
async function videoToStickerOpus(inputPath, outputPath, options) {
  const { maxSeconds, ffmpegBin = 'ffmpeg' } = options
  const intermediatePath = `${outputPath}.step1.ogg`

  const trimArgs = maxSeconds > 0 ? ['-t', String(maxSeconds)] : []

  try {
    await runProcess(ffmpegBin, [
      '-y',
      '-v', 'error',
      '-i', inputPath,
      '-vn',
      ...trimArgs,
      '-c:a', 'libopus',
      '-b:a', '64k',
      intermediatePath,
    ])

    await runProcess(ffmpegBin, [
      '-y',
      '-v', 'error',
      '-i', intermediatePath,
      '-ac', '1',
      '-c:a', 'libopus',
      '-b:a', '32k',
      outputPath,
    ])

    return fs.readFileSync(outputPath)
  } finally {
    try {
      fs.unlinkSync(intermediatePath)
    } catch (_) {}
  }
}

module.exports = {
  WEBP_LADDER,
  probeMedia,
  videoToAnimatedWebp,
  videoToStickerOpus,
}
