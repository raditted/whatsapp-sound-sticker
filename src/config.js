'use strict'

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') })

const ROOT_DIR = path.resolve(__dirname, '..')

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function parsePositiveNumber(value, fallback) {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// 0 disables duration trimming (keeps full media length).
function parseOptionalLimit(value, fallback) {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function parseList(value) {
  if (!value) return new Set()
  return new Set(
    String(value)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

const config = {
  command: (process.env.COMMAND || '.soundsticker').trim().toLowerCase(),
  allowedGroups: parseList(process.env.ALLOWED_GROUPS),
  allowAllGroups: parseBool(process.env.ALLOW_ALL_GROUPS, false),
  allowDm: parseBool(process.env.ALLOW_DM, false),
  allowSelf: parseBool(process.env.ALLOW_SELF, true),
  silentMode: parseBool(process.env.SILENT_MODE, true),

  stickerPack: process.env.STICKER_PACK || 'Sound Sticker',
  stickerAuthor: process.env.STICKER_AUTHOR || 'whatsapp-sound-sticker',
  stickerPackId: process.env.STICKER_PACK_ID || 'com.whatsapp.soundsticker',

  maxVideoSeconds: parseOptionalLimit(process.env.MAX_VIDEO_SECONDS, 10),
  maxAudioSeconds: parseOptionalLimit(process.env.MAX_AUDIO_SECONDS, 9.9),
  maxWebpBytes: parsePositiveNumber(process.env.MAX_WEBP_BYTES, 1_000_000),

  authDir: path.resolve(ROOT_DIR, process.env.AUTH_DIR || 'auth'),
  tmpDir: path.resolve(ROOT_DIR, process.env.TMP_DIR || 'tmp'),
  qrImagePath:
    process.env.QR_IMAGE_PATH === 'none'
      ? null
      : path.resolve(ROOT_DIR, process.env.QR_IMAGE_PATH || 'qr.png'),

  logLevel: process.env.LOG_LEVEL || 'warn',
  proxyUrl: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
  ffmpegBin: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobeBin: process.env.FFPROBE_PATH || 'ffprobe',
}

function isJidAllowed(jid) {
  if (!jid || jid === 'status@broadcast') return false
  if (jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return false
  if (jid.endsWith('@g.us')) {
    return config.allowAllGroups || config.allowedGroups.has(jid)
  }
  return config.allowDm
}

module.exports = { config, isJidAllowed }
