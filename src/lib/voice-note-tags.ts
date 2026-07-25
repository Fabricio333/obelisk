export interface MessageVoiceNote {
  readonly url: string;
  readonly durationSeconds: number;
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function voiceNoteFromTags(
  content: string,
  tags: ReadonlyArray<ReadonlyArray<string>>,
): MessageVoiceNote | null {
  const tag = tags.find((candidate) => candidate[0] === 'voice');
  const url = tag?.[1]?.trim() ?? '';
  const durationSeconds = Number(tag?.[2]);
  if (
    !isHttpUrl(url)
    || content.trim() !== url
    || !Number.isFinite(durationSeconds)
    || durationSeconds < 0
    || durationSeconds > 3600
  ) return null;
  return { url, durationSeconds: Math.round(durationSeconds) };
}

export function voiceNoteTagForContent(
  content: string,
  voiceNote: MessageVoiceNote | null | undefined,
): string[] | null {
  if (!voiceNote || !isHttpUrl(voiceNote.url) || content.trim() !== voiceNote.url || !Number.isFinite(voiceNote.durationSeconds)) return null;
  const duration = Math.max(0, Math.min(3600, Math.round(voiceNote.durationSeconds)));
  return ['voice', voiceNote.url, String(duration)];
}
