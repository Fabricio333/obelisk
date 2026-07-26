'use client';

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { finalizeEvent } from 'nostr-tools/pure';
import { KIND_BLOSSOM_AUTH } from '@/lib/nip-kinds';
import { nostrActions } from '@/lib/nostr-bridge';

const BLOSSOM_SERVERS = [
  'https://blossom.primal.net',
  'https://nostr.build',
  'https://blossom.band',
];

async function createAuthEvent(fileHash: string, secretKey?: Uint8Array): Promise<string> {
  const template = {
    kind: KIND_BLOSSOM_AUTH,
    content: '',
    tags: [
      ['t', 'upload'],
      ['x', fileHash],
      ['expiration', String(Math.floor(Date.now() / 1000) + 3600)],
    ],
    created_at: Math.floor(Date.now() / 1000),
  };
  const event = secretKey
    ? finalizeEvent(template, secretKey)
    : await nostrActions.signEventTemplate(template);
  return btoa(JSON.stringify(event));
}

export async function uploadToBlossom(file: File, secretKey?: Uint8Array): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const hash = bytesToHex(sha256(buffer));
  const authToken = await createAuthEvent(hash, secretKey);

  let lastError: Error | null = null;

  for (const server of BLOSSOM_SERVERS) {
    try {
      const res = await fetch(`${server}/upload`, {
        method: 'PUT',
        headers: {
          'Authorization': `Nostr ${authToken}`,
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: buffer,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`${server}: ${res.status} ${text}`);
      }

      const data = await res.json();
      return data.url as string;
    } catch (err) {
      lastError = err as Error;
      console.warn(`Blossom upload failed on ${server}:`, err);
    }
  }

  throw lastError || new Error('All Blossom servers failed');
}
