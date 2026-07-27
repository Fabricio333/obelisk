# Uploads — Blossom storage and event URLs

Obelisk has no local upload route, upload table, or backend file store. Browser
clients upload directly to Blossom and publish the returned URL in signed Nostr
events.

## Upload flow

`src/lib/blossom.ts` implements the shared BUD-01 flow:

1. Hash the file with SHA-256.
2. Sign a short-lived kind `24242` Blossom authorization event.
3. `PUT` the bytes to the configured Blossom servers, trying each until one
   succeeds.
4. Store the returned absolute HTTP(S) URL in the Nostr event.

The signer is the active Nostr identity. There is no cookie session, API route,
Prisma model, SQL backfill, or site-relative `/uploads/...` URL.

## URL and privacy contract

Blossom media URLs are public by possession. Anyone who receives a message,
pack, profile, or relay-setting event can fetch its media URL, and retaining the
URL may preserve access after relay membership changes. Do not use chat uploads
for private documents, regulated data, or content that requires revocable
access.

Obelisk validates HTTP(S) URLs before accepting media-pack, sticker, and voice
markers. Availability, retention, abuse controls, and deletion remain policies
of the selected Blossom server.

## Media packs

Emoji, GIF, and sticker pack files use this same flow. Named packs, item
favorites, and server favorites store only Blossom URLs in Nostr tags. See
[media-packs.md](media-packs.md) for the complete event contract and migration
flow.

## Voice notes

The composer records microphone audio with the browser MediaRecorder API, shows a live elapsed timer, uploads the finished file through Blossom, and publishes a kind 9 group message. The message content remains the Blossom HTTP URL for client compatibility.

Obelisk adds an explicit event-local marker so an audio-only WebM is never guessed to be video:

~~~json
["voice", "https://blossom.example/<hash>.webm", "5"]
~~~

The third value is the rounded duration in seconds. Clients accept the marker only when the URL is HTTP(S), the trimmed message content exactly matches it, and the duration is between 0 and 3600 seconds. Invalid markers fall back to normal URL rendering.

Tagged voice notes render as a WhatsApp-style dark bubble with a white play/pause control, vertically centered gray/cyan seekable waveform, reserved spacing before the sender avatar and microphone badge, duration, and message time rather than a native video canvas. While recording, the composer shows the elapsed timer, a finish button, and a trash button; trashing at this stage stops the microphone without uploading. After upload, the same waveform appears as a send preview with a second trash action that clears the draft.

For compatibility with voice notes published before the `voice` marker existed, an untagged `.webm` is probed after metadata loads: files with no video track use the voice bubble, while actual WebM video remains in the video player.

Code map:

~~~text
src/components/chat/ComposerActions.tsx  recorder and live timer
src/lib/voice-note-tags.ts              marker validation
src/lib/nostr-bridge/client.ts          event parsing and optimistic state
src/components/chat/MessageContent.tsx  compact audio player
~~~

## Size limits

Per-mime caps (bytes) live in `src/lib/attachments.ts`:

- Images: 10 MB
- Video: 50 MB
- Documents: 25 MB
- Audio: 25 MB

These caps apply to composer attachments. The media-pack editor accepts image
files and delegates final upload acceptance to the selected Blossom server.
