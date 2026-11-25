'use strict'

const pino = require('pino')
const QRCode = require('qrcode')
const { HttpsProxyAgent } = require('https-proxy-agent')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  proto,
} = require('@whiskeysockets/baileys')
const { config, isJidAllowed } = require('./config')
const { StickerQueue, extractCommandVideo } = require('./sticker')

function assertProtoPatched() {
  const hasField134 = 'audioStickerMessage' in proto.Message.prototype
  const hasField26 = 'audioMessage' in proto.Message.StickerMessage.prototype
  if (!hasField134 || !hasField26) {
    console.error('[bot] Baileys WAProto is not patched for audioStickerMessage (field 134 / 26).')
    console.error('[bot] Run "npm run patch" first, then start the bot again.')
    process.exit(1)
  }
}

function describeScope() {
  const parts = []
  if (config.allowAllGroups) {
    parts.push('all groups')
  } else if (config.allowedGroups.size > 0) {
    parts.push(`${config.allowedGroups.size} whitelisted group(s)`)
  } else {
    parts.push('no groups (set ALLOWED_GROUPS or ALLOW_ALL_GROUPS=true)')
  }
  parts.push(config.allowDm ? 'DMs enabled' : 'DMs ignored')
  return parts.join(', ')
}

const stickerQueue = new StickerQueue(config)
let activeSock = null
let reconnectTimer = null
let shuttingDown = false

async function startBot() {
  assertProtoPatched()

  const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
  const { version } = await fetchLatestBaileysVersion()
  const agent = config.proxyUrl ? new HttpsProxyAgent(config.proxyUrl) : undefined

  console.log(`[bot] Baileys v${version.join('.')} | command: ${config.command}`)
  console.log(`[bot] scope: ${describeScope()}`)
  const videoLimit = config.maxVideoSeconds > 0 ? `${config.maxVideoSeconds}s` : 'unlimited'
  const audioLimit = config.maxAudioSeconds > 0 ? `${config.maxAudioSeconds}s` : 'unlimited'
  console.log(`[bot] limits: video=${videoLimit} audio=${audioLimit} webp<=${Math.round(config.maxWebpBytes / 1024)}KB | silent=${config.silentMode}`)
  if (!config.allowAllGroups && config.allowedGroups.size === 0 && !config.allowDm) {
    console.warn('[bot] WARNING: No chats are allowed yet. Copy .env.example to .env and configure ALLOWED_GROUPS, ALLOW_ALL_GROUPS, or ALLOW_DM.')
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: config.logLevel }),
    browser: Browsers.windows('Chrome'),
    printQRInTerminal: false,
    agent,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  })
  activeSock = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      try {
        const ascii = await QRCode.toString(qr, { type: 'terminal', small: true })
        console.log('\n[bot] Scan this QR code in WhatsApp > Linked Devices > Link a device:\n')
        console.log(ascii)
        if (config.qrImagePath) {
          await QRCode.toFile(config.qrImagePath, qr, { width: 400 })
          console.log(`[bot] QR image also saved to ${config.qrImagePath}`)
        }
      } catch (err) {
        console.error('[bot] failed to render QR:', err?.message || err)
      }
    }

    if (connection === 'open') {
      console.log(`[bot] connected as ${sock.user?.id || 'unknown'}. Waiting for "${config.command}"...`)
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      console.log(`[bot] connection closed (statusCode=${code ?? 'unknown'})`)
      sock.ev.removeAllListeners()

      if (shuttingDown) return

      if (code === DisconnectReason.loggedOut) {
        console.error(`[bot] session logged out. Delete "${config.authDir}" and restart to link again.`)
        process.exit(1)
      }

      if (!reconnectTimer) {
        console.log('[bot] reconnecting in 5s...')
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          startBot().catch((err) => {
            console.error('[bot] reconnect error:', err)
            process.exit(1)
          })
        }, 5000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      const remoteJid = m.key?.remoteJid
      if (!isJidAllowed(remoteJid)) continue
      if (!config.allowSelf && m.key?.fromMe) continue
      if (!m.message) continue

      const videoMsg = extractCommandVideo(m.message, config.command)
      if (!videoMsg) continue

      stickerQueue.enqueue(sock, m, videoMsg)
    }
  })
}

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[bot] received ${signal}, shutting down...`)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  try {
    activeSock?.end(undefined)
  } catch (_) {}
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

startBot().catch((err) => {
  console.error('[bot] fatal:', err)
  process.exit(1)
})
