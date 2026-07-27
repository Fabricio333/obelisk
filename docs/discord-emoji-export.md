# Exporting Discord custom emojis (as a regular member)

How to bulk-download the custom emojis of a Discord server you're a member
of, preserving their original names. Useful for creating reusable Obelisk
media packs.

> **ToS note:** scraping via your user token is self-botting and violates Discord's ToS. The DOM/Network method below avoids the API entirely — you're only saving images your browser already fetched to render the emoji picker. Low risk, but not zero.

## Requirements

- macOS (commands use `pbpaste`; on Linux replace with `xclip -o` or `xsel -b`)
- `curl` (preinstalled)
- Discord open in a **browser** (the desktop app also has DevTools via `Ctrl+Shift+I` but browser is easier)

## Procedure

### 1. Reset the working folder

```bash
rm -rf ~/emojis && mkdir ~/emojis && cd ~/emojis
```

### 2. Capture emoji image URLs (Network tab)

1. Open Discord in browser → go to the target server
2. Press **F12** → **Network** tab
3. Filter box: type `emojis`
4. Click 🚫 to clear the list
5. Open the emoji picker, click the server's section
6. **Scroll slowly from top to bottom** so every emoji lazy-loads
7. Right-click any row → **Copy** → **Copy all listed URLs**

### 3. Download the images

```bash
cd ~/emojis
pbpaste > urls.txt
head -3 urls.txt          # sanity check: should print 3 https:// URLs
xargs -n1 curl -O < urls.txt
```

Files land as `<emojiId>.webp` (or `.png`/`.gif`).

### 4. Capture name ↔ ID mapping (Console tab)

With the emoji picker still open and the custom section scrolled through:

1. DevTools → **Console** tab
2. Paste and run:

```js
copy([...document.querySelectorAll('img')]
  .filter(img => img.src.includes('/emojis/'))
  .map(img => {
    const id = img.src.match(/emojis\/(\d+)/)?.[1];
    const name = (img.alt || '').replace(/:/g, '').trim();
    return id && name ? `${id} ${name}` : null;
  })
  .filter(Boolean)
  .join('\n'))
```

Console will print `undefined` — that means the list is on your clipboard.

### 5. Rename files to their emoji names

```bash
cd ~/emojis
pbpaste > names.txt
head -3 names.txt         # should show lines like: 22a2675... nostrgr

while read id name; do
  for f in ${id}.*; do
    [ -e "$f" ] && mv "$f" "${name}.${f##*.}"
  done
done < names.txt
```

### 6. Verify

```bash
ls ~/emojis
```

You should see files like `nostrgr.webp`, `pepe.png`, `warhammerthrust.gif`.

## Troubleshooting

- **`head -3 urls.txt` shows shell commands instead of URLs** — your clipboard was overwritten. Redo step 2, and don't copy anything else before running `pbpaste`.
- **Empty array in Console** — emojis weren't in the DOM when the snippet ran. Reopen picker, scroll through all emojis, then rerun the Console snippet.
- **Some files not renamed** — those emojis weren't visible when step 4 ran. Reopen picker, scroll slowly over the missing ones, redo steps 4 & 5 (existing renamed files won't be touched).
- **Resolution too low** — URLs from the picker default to `size=44`. Before running `curl`, bump resolution:
  ```bash
  sed -i '' 's/size=[0-9]*/size=128/' urls.txt
  ```

## Importing into Obelisk

Once renamed, create a pack in the media library:

1. Open `/app`.
2. Open user preferences → **Emoji, GIFs & stickers**.
3. Choose **New pack** and give it a name.
4. Click **Upload media** and select the renamed files.
5. Review the generated shortcodes and media types, then click **Save pack**.

Obelisk uploads each image to Blossom and publishes a reusable NIP-51 pack.
Favorite the pack to use it on every server, or add it to one server's
favorites as that relay's operator. See [media-packs.md](media-packs.md).
