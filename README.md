# WhatsApp Sound Sticker Bot

A Node.js WhatsApp bot built on [Baileys](https://github.com/WhiskeySockets/Baileys) that converts videos with audio into **square (non-rounded) animated sound stickers**.

Send a video with the trigger caption — or reply to an existing video with the trigger command — and the bot replies with an animated sticker that plays the video's original sound natively in WhatsApp.

## Context

WhatsApp's beta sticker editor allows creating stickers with sound, but applies rounded-corner masking and trims video stickers to 4 seconds. Sound stickers sent directly via WhatsApp's `audioStickerMessage` protobuf structure don't go through that editor UI, so they render as full-bleed squares and aren't locked to the 4-second editor limit (longer clips such as 10s+ play fine as long as the animated WebP fits within WhatsApp's file-size ceiling).

This repository packages that workflow into a ready-to-run bot. Defaults such as optional duration trimming, the ~1 MB WebP size ladder, FIFO queue, group allowlisting, and silent reaction-only mode are simply opinionated starting preferences — not hard protocol requirements — and can be adjusted in `.env` or adapted into your own bot.

## How It Works

WhatsApp does not embed audio inside the `.webp` file itself. A sound sticker consists of **two separately uploaded media files** (an animated WebP and an Ogg Opus audio track) linked together inside a nested protobuf payload:

```text
Incoming video (.soundsticker caption or reply)
  ├── FFmpeg (libwebp_anim) ─► Square animated WebP + RIFF/EXIF metadata
  └── FFmpeg (libopus, 2-pass) ─► Ogg Opus mono 32 kbps
        └─► Upload both via Baileys ─► Relay protobuf:
              Message.audioStickerMessage (field 134, FutureProofMessage)
                └─ Message.stickerMessage
                     └─ StickerMessage.audioMessage (field 26, AudioMessage)
```

Key technical details:

- **Baileys protobuf patch**: `@whiskeysockets/baileys@7.0.0-rc14` does not define `Message.audioStickerMessage` (field `134`) or `StickerMessage.audioMessage` (field `26`) in its compiled `WAProto` schema. `scripts/patch-baileys.js` patches both fields automatically during `npm install` (`postinstall`) and runs an encode/decode round-trip check.
- **Two-pass Opus encoding**: WhatsApp mobile expects mono ~32 kbps Ogg Opus audio. Direct single-pass `video → Opus mono 32k` encoding can trigger `"Couldn't play sticker sound"` on the client, whereas encoding in two passes (`video → stereo Opus 64k`, then `Ogg → mono Opus 32k`) plays reliably.
- **Audio & WebP handling**: There is no strict protocol duration cap enforced on `audioStickerMessage` (only practical WebP file-size constraints); if you enable duration trimming via `.env`, keeping audio slightly shorter than video (e.g. `9.9s` vs `10s`) absorbs Opus trailing-frame padding. Videos without an audio stream fall back to a regular animated WebP sticker. Standard WhatsApp sticker EXIF metadata is injected in pure Node.js (`src/exif.js`) without requiring `webpmux` or Python.

## Prerequisites

- **Node.js** `>= 20`
- **FFmpeg** and **FFprobe** available in `PATH` (with `libwebp_anim` and `libopus` encoders):
  ```bash
  ffmpeg -v error -encoders | grep -E "libwebp_anim|libopus"
  ```

## Quick Start

1. **Clone and install dependencies**:
   ```bash
   git clone <your-repo-url>
   cd whatsapp-sound-sticker
   npm install
   ```
   > `npm install` automatically runs `scripts/patch-baileys.js` via `postinstall` to enable `audioStickerMessage` support in Baileys.

2. **Configure environment variables**:
   ```bash
   cp .env.example .env
   ```
   Open `.env` and set your trigger command and allowed chats (`ALLOWED_GROUPS`, `ALLOW_ALL_GROUPS=true`, or `ALLOW_DM=true`).

3. **Run the bot**:
   ```bash
   npm start
   ```

4. **Link WhatsApp**:
   Scan the QR code displayed in the terminal (also saved to `qr.png`) from **WhatsApp → Linked Devices → Link a device**. Session files are saved in `auth/` — **never share or commit this folder**.

## Usage

- Send a video with caption `.soundsticker` (or your configured `COMMAND`), **or**
- Reply to any video in an allowed chat with `.soundsticker`.

Reactions show job progress:
- `⏳` Processing video
- `✅` Sticker sent
- `❌` Conversion or upload failed

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `COMMAND` | `.soundsticker` | Trigger text (case-insensitive) |
| `ALLOWED_GROUPS` | *(empty)* | Comma-separated group JIDs (`...@g.us`) |
| `ALLOW_ALL_GROUPS` | `false` | Allow commands in any group |
| `ALLOW_DM` | `false` | Allow commands in direct messages |
| `ALLOW_SELF` | `true` | Allow triggering from the bot's own WhatsApp account |
| `SILENT_MODE` | `true` | Send only stickers and reactions (no text replies) |
| `STICKER_PACK` | `Sound Sticker` | Sticker pack name in EXIF metadata |
| `STICKER_AUTHOR` | `whatsapp-sound-sticker` | Sticker publisher name in EXIF metadata |
| `MAX_VIDEO_SECONDS` | `10` | Optional max video duration in seconds (`0` disables trimming) |
| `MAX_AUDIO_SECONDS` | `9.9` | Optional max audio duration in seconds (`0` disables trimming) |
| `MAX_WEBP_BYTES` | `1000000` | Maximum WebP file size in bytes (~1 MB ceiling for animated playback) |
| `HTTPS_PROXY` | *(empty)* | Optional HTTP/HTTPS proxy URL |

See [.env.example](.env.example) for all options.
