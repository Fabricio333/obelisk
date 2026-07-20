import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HistoryPaginationStatus from './HistoryPaginationStatus';

describe('HistoryPaginationStatus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delays the loading overlay so fast pagination does not flash', () => {
    vi.useFakeTimers();
    render(
      <HistoryPaginationStatus
        loading
        reachedStart={false}
        atTop
        loadingLabel="Loading earlier messages..."
        endLabel="No earlier messages"
      />,
    );

    expect(screen.queryByTestId('messages-history-loading')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(screen.getByTestId('messages-history-loading')).toHaveTextContent('Loading earlier messages...');
  });

  it('shows the confirmed end state without a spinner', () => {
    render(
      <HistoryPaginationStatus
        loading={false}
        reachedStart
        atTop
        loadingLabel="Loading earlier messages..."
        endLabel="No earlier messages"
      />,
    );

    expect(screen.getByTestId('messages-history-end')).toHaveTextContent('No earlier messages');
    expect(screen.queryByTestId('messages-history-loading')).toBeNull();
  });

  it("hides the confirmed end state when the user scrolls away from the top", () => {
    render(
      <HistoryPaginationStatus
        loading={false}
        reachedStart
        atTop={false}
        loadingLabel="Loading earlier messages..."
        endLabel="No earlier messages"
      />,
    );

    expect(screen.queryByTestId("messages-history-end")).toBeNull();
  });
});
