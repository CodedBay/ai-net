import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { NotificationProvider, NOTIFICATIONS_STORAGE_KEY } from '../context/NotificationContext';
import NotificationsPage from './NotificationsPage';
import type { AppNotification } from '../types/notification';

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion');
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => <div ref={ref} {...props}>{children}</div>
      ),
      li: React.forwardRef<HTMLLIElement, React.LiHTMLAttributes<HTMLLIElement>>(
        ({ children, ...props }, ref) => <li ref={ref} {...props}>{children}</li>
      ),
    },
  };
});

const buildNotifications = (count: number): AppNotification[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `page-notif-${index}`,
    type: index % 2 === 0 ? 'task_completed' : 'payment_received',
    title: `Page notification ${index}`,
    message: `Page message ${index}`,
    timestamp: new Date(Date.now() - index * 60000).toISOString(),
    read: index > 1,
  }));

const renderPage = (initialNotifications?: AppNotification[]) => {
  if (initialNotifications) {
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(initialNotifications));
  } else {
    localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
  }

  return render(
    <MemoryRouter>
      <NotificationProvider>
        <NotificationsPage />
      </NotificationProvider>
    </MemoryRouter>
  );
};

describe('NotificationsPage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  test('renders the full notification list, not just the five most recent', () => {
    renderPage(buildNotifications(7));

    expect(screen.getByRole('heading', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getAllByTestId(/^notification-item-/)).toHaveLength(7);
    expect(screen.getByTestId('notification-item-page-notif-0')).toBeInTheDocument();
    expect(screen.getByTestId('notification-item-page-notif-6')).toBeInTheDocument();
    expect(screen.getByTestId('notifications-page-unread-badge')).toHaveTextContent('2 unread');
  });

  test('marks all notifications as read', async () => {
    renderPage(buildNotifications(4));

    const markAllButton = screen.getByTestId('mark-all-read-btn');
    expect(markAllButton).toBeInTheDocument();
    expect(screen.getByTestId('notifications-page-unread-badge')).toHaveTextContent('2 unread');

    await act(async () => {
      fireEvent.click(markAllButton);
    });

    expect(screen.queryByTestId('notifications-page-unread-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mark-all-read-btn')).not.toBeInTheDocument();

    const stored = JSON.parse(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) || '[]');
    expect(stored.every((notification: AppNotification) => notification.read)).toBe(true);
  });

  test('shows an empty state when there are no notifications', () => {
    renderPage([]);

    expect(screen.getByTestId('notifications-page-empty-state')).toBeInTheDocument();
    expect(screen.getByText('No notifications yet')).toBeInTheDocument();
    expect(screen.queryByTestId('mark-all-read-btn')).not.toBeInTheDocument();
  });
});
