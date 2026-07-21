import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  publishProfile: vi.fn().mockResolvedValue(undefined),
  upload: vi.fn().mockResolvedValue('https://blossom.primal.net/abc123.jpg'),
  profile: null as null | {
    pubkey: string;
    name: string | null;
    displayName: string | null;
    picture: string | null;
    about: string | null;
    nip05: string | null;
    banner: string | null;
    lud16: string | null;
    website: string | null;
  },
}));

vi.mock('@/lib/nostr-bridge', () => ({
  useMyPubkey: () => 'abc123',
  useSignerReady: () => true,
  useUserMetadata: () => mocks.profile,
  nostrActions: { editUserMetadata: mocks.publishProfile },
}));

vi.mock('@/lib/blossom', () => ({
  uploadToBlossom: (...args: unknown[]) => mocks.upload(...args),
}));

vi.mock('@/i18n/context', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import ProfileEditor from './ProfileEditor';

describe('ProfileEditor', () => {
  const mockOnComplete = vi.fn();
  const mockOnSkip = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.profile = null;
  });

  describe('setup mode', () => {
    it('renders setup title', () => {
      render(<ProfileEditor mode="setup" onComplete={mockOnComplete} onSkip={mockOnSkip} />);
      expect(screen.getByText('profileEditor.setupTitle')).toBeInTheDocument();
    });

    it('does not render a skip button (name is mandatory)', () => {
      render(<ProfileEditor mode="setup" onComplete={mockOnComplete} onSkip={mockOnSkip} />);
      expect(screen.queryByText('profileEditor.skip')).not.toBeInTheDocument();
    });

    it('generates a random name when dice button is clicked', async () => {
      render(<ProfileEditor mode="setup" onComplete={mockOnComplete} onSkip={mockOnSkip} />);
      const input = screen.getByPlaceholderText('profileEditor.namePlaceholder') as HTMLInputElement;
      expect(input.value).toBe('');
      await userEvent.click(screen.getByLabelText('profileEditor.randomName'));
      expect(input.value).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+\d+$/);
    });

    it('disables publish when name is empty (mandatory)', () => {
      render(<ProfileEditor mode="setup" onComplete={mockOnComplete} onSkip={mockOnSkip} />);
      const publishBtn = screen.getByText('profileEditor.publish');
      expect(publishBtn).toBeDisabled();
    });

    it('publishes profile via bridge.editUserMetadata and calls onComplete', async () => {
      render(<ProfileEditor mode="setup" onComplete={mockOnComplete} onSkip={mockOnSkip} />);

      await userEvent.type(screen.getByPlaceholderText('profileEditor.namePlaceholder'), 'Alice');
      await userEvent.click(screen.getByText('profileEditor.publish'));

      await waitFor(() => {
        expect(mocks.publishProfile).toHaveBeenCalledWith({
          name: 'Alice',
          displayName: 'Alice',
        });
      });

      await waitFor(() => {
        expect(mockOnComplete).toHaveBeenCalled();
      });
    });

    it('uploads picture to blossom when file is selected', async () => {
      render(<ProfileEditor mode="setup" onComplete={mockOnComplete} onSkip={mockOnSkip} />);

      // Type name first (mandatory)
      await userEvent.type(screen.getByPlaceholderText('profileEditor.namePlaceholder'), 'Alice');

      // Simulate file selection
      const file = new File(['pixels'], 'avatar.png', { type: 'image/png' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await userEvent.upload(fileInput, file);

      await userEvent.click(screen.getByText('profileEditor.publish'));

      await waitFor(() => {
        expect(mocks.upload).toHaveBeenCalledWith(file);
      });

      await waitFor(() => {
        expect(mocks.publishProfile).toHaveBeenCalledWith({
          name: 'Alice',
          displayName: 'Alice',
          picture: 'https://blossom.primal.net/abc123.jpg',
        });
      });
    });
  });

  describe('edit mode', () => {
    it('pre-fills from cached kind:0 data', async () => {
      mocks.profile = {
        pubkey: 'abc123',
        name: 'OldName',
        displayName: 'OldName',
        picture: 'https://example.com/old.jpg',
        about: 'Old bio',
        nip05: 'user@example.com',
        banner: null,
        lud16: 'user@walletofsatoshi.com',
        website: null,
      };

      render(<ProfileEditor mode="edit" onComplete={mockOnComplete} />);

      await waitFor(() => {
        expect(screen.getByDisplayValue('OldName')).toBeInTheDocument();
        expect(screen.getByDisplayValue('Old bio')).toBeInTheDocument();
      });
    });

    it('renders edit title and cancel button', async () => {
      mocks.profile = {
        pubkey: 'abc123',
        name: 'X',
        displayName: 'X',
        picture: null,
        about: null,
        nip05: null,
        banner: null,
        lud16: null,
        website: null,
      };
      render(<ProfileEditor mode="edit" onComplete={mockOnComplete} />);

      await waitFor(() => {
        expect(screen.getByText('profileEditor.editTitle')).toBeInTheDocument();
        expect(screen.getByText('profileEditor.cancel')).toBeInTheDocument();
      });
    });

    it('shows confirmation before publishing in edit mode', async () => {
      mocks.profile = {
        pubkey: 'abc123',
        name: 'OldName',
        displayName: 'OldName',
        picture: null,
        about: null,
        nip05: 'keep@me.com',
        banner: null,
        lud16: null,
        website: null,
      };

      render(<ProfileEditor mode="edit" onComplete={mockOnComplete} />);

      await waitFor(() => {
        expect(screen.getByDisplayValue('OldName')).toBeInTheDocument();
      });

      const nameInput = screen.getByDisplayValue('OldName');
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, 'NewName');

      await userEvent.click(screen.getByText('profileEditor.publish'));

      expect(screen.getByText('profileEditor.confirmDesc')).toBeInTheDocument();
    });

    it('calls onComplete when cancel is clicked', async () => {
      mocks.profile = {
        pubkey: 'abc123',
        name: 'X',
        displayName: 'X',
        picture: null,
        about: null,
        nip05: null,
        banner: null,
        lud16: null,
        website: null,
      };
      render(<ProfileEditor mode="edit" onComplete={mockOnComplete} />);

      await waitFor(() => {
        expect(screen.getByText('profileEditor.cancel')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText('profileEditor.cancel'));
      expect(mockOnComplete).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('shows error when publish fails', async () => {
      mocks.publishProfile.mockRejectedValueOnce(new Error('Network error'));

      render(<ProfileEditor mode="setup" onComplete={mockOnComplete} onSkip={mockOnSkip} />);

      await userEvent.type(screen.getByPlaceholderText('profileEditor.namePlaceholder'), 'Alice');
      await userEvent.click(screen.getByText('profileEditor.publish'));

      await waitFor(() => {
        expect(screen.getByText('profileEditor.publishError')).toBeInTheDocument();
      });
      expect(mockOnComplete).not.toHaveBeenCalled();
    });

    it('shows error when blossom upload fails', async () => {
      mocks.upload.mockRejectedValueOnce(new Error('Server error'));

      render(<ProfileEditor mode="setup" onComplete={mockOnComplete} onSkip={mockOnSkip} />);

      await userEvent.type(screen.getByPlaceholderText('profileEditor.namePlaceholder'), 'Alice');

      const file = new File(['pixels'], 'avatar.png', { type: 'image/png' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await userEvent.upload(fileInput, file);

      await userEvent.click(screen.getByText('profileEditor.publish'));

      await waitFor(() => {
        expect(screen.getByText('profileEditor.publishError')).toBeInTheDocument();
      });
    });
  });
});
