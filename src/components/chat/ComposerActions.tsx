'use client';

import { useEffect, useRef, useState } from 'react';
import { VoiceMessage } from './MessageContent';
import type { MessageVoiceNote } from '@/lib/voice-note-tags';

const iconClass = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lc-muted hover:bg-white/5 hover:text-lc-white disabled:opacity-40';

export function AttachmentMenu({
  disabled,
  onFiles,
  onContact,
  onNewSticker,
}: {
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  onContact: (value: string) => void;
  onNewSticker: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLInputElement>(null);
  const documentRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const pick = (ref: React.RefObject<HTMLInputElement | null>) => {
    setOpen(false);
    ref.current?.click();
  };
  const input = (ref: React.RefObject<HTMLInputElement | null>, accept?: string, capture?: 'environment') => (
    <input
      ref={ref}
      type="file"
      accept={accept}
      capture={capture}
      multiple={!capture}
      className="hidden"
      onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        if (files.length) onFiles(files);
        event.target.value = '';
      }}
    />
  );
  const contact = () => {
    setOpen(false);
    const value = window.prompt('Enter a Nostr npub or hex public key');
    if (value?.trim()) onContact(value.trim());
  };

  return (
    <div ref={rootRef} className="relative">
      {input(mediaRef, 'image/*,video/*')}
      {input(documentRef)}
      {input(cameraRef, 'image/*', 'environment')}
      <button
        type="button"
        className={iconClass}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-label="Add attachment"
        aria-expanded={open}
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-2 w-56 overflow-hidden rounded-2xl border border-lc-border bg-lc-dark p-2 text-sm text-lc-white shadow-2xl" role="menu">
          <MenuItem label="Document" icon="document" onClick={() => pick(documentRef)} />
          <MenuItem label="Photos & videos" icon="media" onClick={() => pick(mediaRef)} />
          <MenuItem label="Camera" icon="camera" onClick={() => pick(cameraRef)} />
          <MenuItem label="Contact" icon="contact" onClick={contact} />
          <MenuItem label="New sticker" icon="sticker" onClick={() => { setOpen(false); onNewSticker(); }} />
          <MenuItem label="Poll" icon="poll" disabled />
          <MenuItem label="Event" icon="event" disabled />
        </div>
      )}
    </div>
  );
}

type MenuIconKind = "document" | "media" | "camera" | "contact" | "sticker" | "poll" | "event";

function MenuItem({ label, icon, onClick, disabled }: { label: string; icon: MenuIconKind; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-35"
    >
      <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-lc-green/15 text-lc-green">
        <MenuIcon kind={icon} />
      </span>
      <span>{label}</span>
      {disabled && <span className="ml-auto text-[10px] uppercase tracking-wide text-lc-muted">Later</span>}
    </button>
  );
}

function MenuIcon({ kind }: { kind: MenuIconKind }) {
  const props = {
    className: "h-[18px] w-[18px]",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (kind === "document") return <svg {...props}><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v5h5M10 13h5M10 17h5" /></svg>;
  if (kind === "media") return <svg {...props}><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="m4 17 5-4 3 2 3-3 5 5" /></svg>;
  if (kind === "camera") return <svg {...props}><path d="M4 8h3l1.5-2h7L17 8h3v11H4z" /><circle cx="12" cy="13.5" r="3.5" /></svg>;
  if (kind === "contact") return <svg {...props}><circle cx="12" cy="8" r="3" /><path d="M6 20a6 6 0 0 1 12 0M4 4v16M20 4v16" /></svg>;
  if (kind === "sticker") return <StickerIcon className="h-[18px] w-[18px]" />;
  if (kind === "poll") return <svg {...props}><path d="M5 19V9M12 19V5M19 19v-7" /><path d="M3 19h18" /></svg>;
  return <svg {...props}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" /></svg>;
}

export function StickerIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3h12a3 3 0 0 1 3 3v8l-7 7H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" />
      <path d="M14 21v-4a3 3 0 0 1 3-3h4M8 10h.01M16 10h.01M8 14s1.5 1.5 4 1.5 4-1.5 4-1.5" />
    </svg>
  );
}

function formatDuration(seconds: number): string {
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

function TrashIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
    </svg>
  );
}

export function VoiceNoteDraft({
  note,
  onDiscard,
}: {
  note: MessageVoiceNote;
  onDiscard: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1" data-testid="voice-note-draft">
      <VoiceMessage note={note} compact />
      <button
        type="button"
        onClick={onDiscard}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lc-muted hover:bg-red-500/10 hover:text-red-400"
        aria-label="Discard voice note"
        title="Discard voice note"
      >
        <TrashIcon />
      </button>
    </div>
  );
}

export function VoiceNoteButton({
  disabled,
  onRecorded,
}: {
  disabled?: boolean;
  onRecorded: (file: File, durationSeconds: number) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const discardedRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef(0);

  useEffect(() => () => {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") {
      discardedRecorderRef.current = recorder;
      recorder.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);
  useEffect(() => {
    if (!recording) return;
    const update = () => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  const stop = (discard = false) => {
    const recorder = recorderRef.current;
    if (recorder?.state !== "recording") return;
    if (discard) discardedRecorderRef.current = recorder;
    recorder.stop();
    setRecording(false);
  };

  const start = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      if (streamRef.current === stream) streamRef.current = null;
      if (recorderRef.current === recorder) recorderRef.current = null;
      if (discardedRecorderRef.current === recorder) {
        discardedRecorderRef.current = null;
        return;
      }
      const durationSeconds = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
      onRecorded(
        new File(chunks, "voice-" + Date.now() + ".weba", { type: recorder.mimeType || "audio/webm" }),
        durationSeconds,
      );
    };
    streamRef.current = stream;
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setElapsed(0);
    recorder.start();
    setRecording(true);
  };

  if (recording) {
    return (
      <span className="flex shrink-0 items-center gap-1" data-testid="voice-recording-controls">
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-full text-lc-muted hover:bg-red-500/10 hover:text-red-400"
          onClick={() => stop(true)}
          aria-label="Discard voice recording"
          title="Discard voice recording"
        >
          <TrashIcon />
        </button>
        <span className="flex items-center gap-2 px-1 font-mono text-sm text-red-400">
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-400" aria-hidden="true" />
          <span data-testid="voice-recording-time">{formatDuration(elapsed)}</span>
        </span>
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-red-500/15 text-red-400 hover:bg-red-500/25"
          onClick={() => stop(false)}
          aria-label="Stop voice note"
          title="Finish recording"
        >
          <span className="h-3 w-3 rounded-[3px] bg-current" aria-hidden="true" />
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      className={iconClass}
      disabled={disabled}
      onClick={() => void start()}
      aria-label="Record voice note"
    >
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" />
      </svg>
    </button>
  );
}
