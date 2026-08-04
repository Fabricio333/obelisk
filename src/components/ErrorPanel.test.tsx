import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ErrorPanel from './ErrorPanel';

const reload = vi.fn();

beforeEach(() => {
  reload.mockClear();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  });
  document.documentElement.lang = 'en';
  window.localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function boom(message = 'Cannot read properties of undefined') {
  return Object.assign(new Error(message), { digest: 'abc123' });
}

describe('ErrorPanel', () => {
  it('renders the recovery card instead of a blank screen', () => {
    render(<ErrorPanel error={boom()} reset={() => {}} />);
    expect(screen.getByTestId('error-panel')).toBeInTheDocument();
    expect(screen.getByText('Something broke on this screen')).toBeInTheDocument();
  });

  it('surfaces the error message and digest so a report is actionable', () => {
    render(<ErrorPanel error={boom('bolt11 decode failed')} reset={() => {}} />);
    const detail = screen.getByTestId('error-panel-detail');
    expect(detail).toHaveTextContent('bolt11 decode failed');
    expect(detail).toHaveTextContent('digest: abc123');
  });

  it('calls reset() so recovery does not require a full page load', () => {
    const reset = vi.fn();
    render(<ErrorPanel error={boom()} reset={reset} />);
    fireEvent.click(screen.getByTestId('error-retry'));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('omits the retry button when no reset is available', () => {
    render(<ErrorPanel error={boom()} />);
    expect(screen.queryByTestId('error-retry')).not.toBeInTheDocument();
    // Reload is the fallback path and must still be offered.
    expect(screen.getByTestId('error-reload')).toBeInTheDocument();
  });

  it('reloads the page on demand', () => {
    render(<ErrorPanel error={boom()} reset={() => {}} />);
    fireEvent.click(screen.getByTestId('error-reload'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('clears cached relay data but keeps the session, then reloads', () => {
    vi.useFakeTimers();
    window.localStorage.setItem('obelisk-cache-v4/wss:relay/9/group', '{"v":1}');
    window.localStorage.setItem('obelisk-read-state:abc', '{}');
    window.localStorage.setItem('obelisk-dex/session', '{"pubKeyHex":"deadbeef"}');

    render(<ErrorPanel error={boom()} reset={() => {}} />);
    fireEvent.click(screen.getByTestId('error-clear-cache'));

    // Session survives — "clear cache" must not log the user out.
    expect(window.localStorage.getItem('obelisk-dex/session')).toBe('{"pubKeyHex":"deadbeef"}');
    expect(window.localStorage.getItem('obelisk-cache-v4/wss:relay/9/group')).toBeNull();
    expect(window.localStorage.getItem('obelisk-read-state:abc')).toBeNull();
    expect(screen.getByTestId('error-cleared-note')).toHaveTextContent('Cleared 2 entries');

    act(() => { vi.advanceTimersByTime(500); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads when storage is unreadable', () => {
    vi.useFakeTimers();
    // Private mode / disabled storage: enumeration itself fails. Recovery
    // must not depend on the wipe succeeding.
    const key = vi.spyOn(window.localStorage, 'key').mockImplementation(() => {
      throw new Error('SecurityError: localStorage is disabled');
    });

    render(<ErrorPanel error={boom()} reset={() => {}} />);
    fireEvent.click(screen.getByTestId('error-clear-cache'));
    act(() => { vi.advanceTimersByTime(500); });

    expect(reload).toHaveBeenCalledTimes(1);
    key.mockRestore();
  });

  it('follows <html lang> for copy, with no locale provider mounted', () => {
    document.documentElement.lang = 'es';
    render(<ErrorPanel error={boom()} reset={() => {}} />);
    expect(screen.getByText('Algo se rompió en esta pantalla')).toBeInTheDocument();
  });

  it('logs the original error, which production builds otherwise swallow', () => {
    const err = boom('unreachable');
    render(<ErrorPanel error={err} reset={() => {}} />);
    expect(console.error).toHaveBeenCalledWith(
      '[obelisk] render error boundary caught:',
      err,
    );
  });
});
