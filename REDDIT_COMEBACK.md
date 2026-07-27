# OBELISK: THE COMEBACK

Hey r/nostr,

I paused development for a few months after the relay-native rewrite shipped. Now I am back to continue building Obelisk, a Discord-like experience powered by Nostr.

**Latest additions:** audio messages, a sticker, emoji and GIF marketplace, and Nostr feeds for discovering people and exploring profiles across public relays.

**Already there:** NIP-29 communities with channels, categories and forums, encrypted DMs, zaps, Blossom uploads, an installable mobile PWA, peer-to-peer voice and video calls, and large calls through a mediasoup SFU.

Obelisk still has no chat backend or platform database. Your Nostr key is your account, NIP-29 relays hold the communities and messages, Blossom stores uploaded media, and Nostr coordinates calls.

One important privacy clarification: voice notes and other Blossom uploads are currently not encrypted. Anyone who obtains the media URL can access the file. Small peer-to-peer calls use WebRTC encryption directly between participants. Large SFU calls are encrypted between each participant and the SFU, but the SFU can access the media, so they are not yet end-to-end encrypted against the SFU.

See all the features:

https://obelisk.ar/features

Try it:

https://obelisk.ar

Source:

https://github.com/obelisk-app/obelisk

Come test it and break it hahah.

**AI usage disclaimer:** Obelisk has been built with substantial AI assistance for implementation, debugging, tests, and documentation. I review and test what gets shipped and remain responsible for it. AI-assisted software can still contain unexpected behavior and security vulnerabilities, and Obelisk has not yet received a complete independent security audit.
