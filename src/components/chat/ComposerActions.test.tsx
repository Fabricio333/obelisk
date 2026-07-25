import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentMenu, VoiceNoteButton, VoiceNoteDraft } from './ComposerActions';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AttachmentMenu', () => {
  it('offers implemented actions and marks deferred actions', () => {
    render(
      <AttachmentMenu
        onFiles={() => {}}
        onContact={() => {}}
        onNewSticker={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }));

    expect(screen.getAllByRole('menuitem')).toHaveLength(7);
    screen.getAllByRole('menuitem').forEach((item) => {
      expect(item.querySelector('svg')).toBeInTheDocument();
    });
    expect(screen.getByRole('menuitem', { name: 'Document' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: 'Photos & videos' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: 'Camera' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: 'Contact' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: 'New sticker' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: /Poll/ })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /Event/ })).toBeDisabled();
  });

  it('opens personal sticker creation', () => {
    const onNewSticker = vi.fn();
    render(
      <AttachmentMenu
        onFiles={() => {}}
        onContact={() => {}}
        onNewSticker={onNewSticker}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New sticker' }));
    expect(onNewSticker).toHaveBeenCalledOnce();
  });
});


describe("VoiceNoteDraft", () => {
  it("lets the user discard a finished recording", () => {
    const onDiscard = vi.fn();
    render(
      <VoiceNoteDraft
        note={{ url: "https://cdn.example/voice.webm", durationSeconds: 5 }}
        onDiscard={onDiscard}
      />,
    );

    expect(screen.getByTestId("voice-waveform")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard voice note" }));
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});

describe("VoiceNoteButton", () => {
  it("shows elapsed recording time and returns the final duration", async () => {
    vi.useFakeTimers({ now: 0 });
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }) },
    });
    class FakeMediaRecorder {
      state: RecordingState = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() { this.state = "recording"; }
      stop() { this.state = "inactive"; this.onstop?.(); }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const onRecorded = vi.fn();

    render(<VoiceNoteButton onRecorded={onRecorded} />);
    fireEvent.click(screen.getByRole("button", { name: "Record voice note" }));
    await act(async () => {});

    expect(screen.getByTestId("voice-recording-time")).toHaveTextContent("0:00");
    act(() => vi.advanceTimersByTime(2100));
    expect(screen.getByTestId("voice-recording-time")).toHaveTextContent("0:02");

    fireEvent.click(screen.getByRole("button", { name: "Discard voice recording" }));
    expect(onRecorded).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Record voice note" }));
    await act(async () => {});
    act(() => vi.advanceTimersByTime(2100));
    fireEvent.click(screen.getByRole("button", { name: "Stop voice note" }));

    expect(onRecorded).toHaveBeenCalledWith(expect.any(File), 2);
    expect(stopTrack).toHaveBeenCalledTimes(2);
  });
});
