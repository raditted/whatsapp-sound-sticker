'use strict'

const fs = require('fs')
const path = require('path')
const pino = require('pino')
const {
  downloadContentFromMessage,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
} = require('@whiskeysockets/baileys')
const { buildStickerExif } = require('./exif')
const { probeMedia, videoToAnimatedWebp, videoToStickerOpus } = require('./media')

const silentLogger = pino({ level: 'silent' })

function unwrapMessage(message) {
  let current = message
  while (current) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message
    } else if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message
    } else if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message
    } else {
      break
    }
  }
  return current
}

function extractCommandVideo(rawMessage, command) {
  const msg = unwrapMessage(rawMessage)
  if (!msg) return null

  const text = (
    msg.videoMessage?.caption ||
    msg.extendedTextMessage?.text ||
    msg.conversation ||
    ''
  ).trim()

  if (text.toLowerCase() !== command) return null

  if (msg.videoMessage) return msg.videoMessage

  const quoted = unwrapMessage(msg.extendedTextMessage?.contextInfo?.quotedMessage)
  if (quoted?.videoMessage) return quoted.videoMessage

  return null
}

async function downloadVideoBuffer(videoMsg) {
  const stream = await downloadContentFromMessage(videoMsg, 'video')
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function react(sock, m, emoji) {
  try {
    await sock.sendMessage(m.key.remoteJid, { react: { text: emoji, key: m.key } })
  } catch (err) {
    console.warn(`[bot] reaction ${emoji} failed:`, err?.message || err)
  }
}

class StickerQueue {
  constructor(config) {
    this.config = config
    this.queue = []
    this.busy = false
    this.exifPayload = buildStickerExif({
      pack: config.stickerPack,
      author: config.stickerAuthor,
      packId: config.stickerPackId,
    })

    fs.mkdirSync(config.tmpDir, { recursive: true })
  }

  enqueue(sock, m, videoMsg) {
    this.queue.push({ sock, m, videoMsg })
    console.log(`[bot] queued ${m.key?.id} from ${m.key?.remoteJid} (pending=${this.queue.length})`)
    this.pump()
  }

  async pump() {
    if (this.busy) return
    const job = this.queue.shift()
    if (!job) return
    this.busy = true
    try {
      await this.processJob(job.sock, job.m, job.videoMsg)
    } finally {
      this.busy = false
      this.pump()
    }
  }

  async processJob(sock, m, videoMsg) {
    const id = m.key?.id || `job-${Date.now()}`
    const chatJid = m.key?.remoteJid
    const prefix = `[bot] ${id}:`
    const base = path.join(this.config.tmpDir, id.replace(/[^a-zA-Z0-9_-]/g, '_'))
    const inFile = `${base}.mp4`
    const webpFile = `${base}.webp`
    const oggFile = `${base}.ogg`

    console.log(`${prefix} processing from ${chatJid}`)
    await react(sock, m, '⏳')

    try {
      const videoBuf = await downloadVideoBuffer(videoMsg)
      if (!videoBuf.length) throw new Error('Downloaded video is empty')
      fs.writeFileSync(inFile, videoBuf)

      const { hasAudio, duration } = await probeMedia(inFile, this.config.ffprobeBin)
      console.log(`${prefix} video ${videoBuf.length}B duration=${duration}s hasAudio=${hasAudio}`)

      const { buffer: webpBuf, size: webpSize } = await videoToAnimatedWebp(inFile, webpFile, {
        maxSeconds: this.config.maxVideoSeconds,
        maxBytes: this.config.maxWebpBytes,
        exifPayload: this.exifPayload,
        ffmpegBin: this.config.ffmpegBin,
        logPrefix: prefix,
      })

      let oggBuf = null
      if (hasAudio) {
        oggBuf = await videoToStickerOpus(inFile, oggFile, {
          maxSeconds: this.config.maxAudioSeconds,
          ffmpegBin: this.config.ffmpegBin,
        })
        console.log(`${prefix} opus ${oggBuf.length} bytes`)
      }

      const uploadOpts = { upload: sock.waUploadToServer, logger: silentLogger }
      const { stickerMessage } = await prepareWAMessageMedia({ sticker: webpBuf }, uploadOpts)
      stickerMessage.isAnimated = true
      stickerMessage.width = webpSize
      stickerMessage.height = webpSize

      let sentId
      if (oggBuf) {
        const { audioMessage } = await prepareWAMessageMedia({ audio: oggBuf }, uploadOpts)
        stickerMessage.audioMessage = audioMessage

        const content = { audioStickerMessage: { message: { stickerMessage } } }
        const waMsg = generateWAMessageFromContent(chatJid, content, { userJid: sock.user.id })
        await sock.relayMessage(chatJid, waMsg.message, { messageId: waMsg.key.id })
        sentId = waMsg.key.id
        console.log(`${prefix} SENT sound sticker ${sentId} (audio=${audioMessage.seconds}s)`)
      } else {
        const waMsg = await sock.sendMessage(chatJid, { sticker: webpBuf })
        sentId = waMsg?.key?.id
        console.log(`${prefix} SENT silent sticker ${sentId} (no audio track)`)
      }

      await react(sock, m, '✅')
    } catch (err) {
      console.error(`${prefix} FAILED:`, err?.message || err)
      await react(sock, m, '❌')
      if (!this.config.silentMode) {
        try {
          await sock.sendMessage(
            chatJid,
            { text: `Failed to create sound sticker: ${err?.message || 'unknown error'}` },
            { quoted: m },
          )
        } catch (_) {}
      }
    } finally {
      for (const file of [inFile, webpFile, oggFile]) {
        try {
          fs.unlinkSync(file)
        } catch (_) {}
      }
    }
  }
}

module.exports = { StickerQueue, extractCommandVideo, unwrapMessage }
