import { describe, expect, it } from 'vitest';
import { voiceNoteFromTags, voiceNoteTagForContent } from './voice-note-tags';

describe('voice-note tags', () => {
  it('round-trips a bounded duration for an exact URL-only message', () => {
    const url = 'https://cdn.example/voice.webm';
    const tag = voiceNoteTagForContent(url, { url, durationSeconds: 4.6 });
    expect(tag).toEqual(['voice', url, '5']);
    expect(voiceNoteFromTags(url, [tag!])).toEqual({ url, durationSeconds: 5 });
  });

  it('rejects mismatched content and unsafe URLs', () => {
    expect(voiceNoteFromTags('caption', [['voice', 'https://cdn.example/a.webm', '2']])).toBeNull();
    expect(voiceNoteTagForContent('javascript:x', {
      url: 'javascript:x',
      durationSeconds: 2,
    })).toBeNull();
    expect(voiceNoteTagForContent('https://cdn.example/a.webm', {
      url: 'https://cdn.example/a.webm',
      durationSeconds: Number.NaN,
    })).toBeNull();
  });
});
