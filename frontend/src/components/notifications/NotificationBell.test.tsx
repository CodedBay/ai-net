import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { NotificationProvider, NOTIFICATIONS_STORAGE_KEY } from '../../context/NotificationContext';
import NotificationBell from './NotificationBell';
import type { AppNotification } from '../../types/notification';

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

const sampleNotifications: AppNotification[] = [
  {
    id: 'bell-notif-1',
    type: 'task_completed',
    title: 'Task Done',
    message: 'Finished task 1',
    timestamp: new Date().toISOString(),
    read: false,
  },
  {
    id: 'bell-notif-2',
    type: 'payment_received',
    title: 'Funds Received',
    message: 'Received 10 XLM',
    timestamp: new Date().toISOString(),
    read: false,
  },
  {
    id: 'bell-notif-3',
    type: 'agent_registered',
    title: 'Agent Added',
    message: 'New agent ready',
    timestamp: new Date().toISOString(),
    read: true,
  },
];

const renderBellWithProvider = (initial?: AppNotification[]) => {
  if (initial) {
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(initial));
  } else {
    localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
  }

  return render(
    <MemoryRouter>
      <NotificationProvider>
        <NotificationBell />
      </NotificationProvider>
    </MemoryRouter>
  );
};

describe('NotificationBell Component', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  test('renders bell button and badge with unread count', () => {
    renderBellWithProvider(sampleNotifications);

    const bellBtn = screen.getByTestId('notification-bell-btn');
    expect(bellBtn).toBeInTheDocument();

    const badge = screen.getByTestId('notification-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('2');
  });

  test('toggles dropdown panel on button click', async () => {
    renderBellWithProvider(sampleNotifications);

    const bellBtn = screen.getByTestId('notification-bell-btn');
    expect(screen.queryByTestId('notification-panel')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(bellBtn);
    });

    expect(screen.getByTestId('notification-panel')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(bellBtn);
    });

    expect(screen.queryByTestId('notification-panel')).not.toBeInTheDocument();
  });

  test('exposes the dialog relationship and unread count on the bell button', async () => {
    renderBellWithProvider(sampleNotifications);

    const bellBtn = screen.getByTestId('notification-bell-btn');
    expect(bellBtn).toHaveAttribute('aria-haspopup', 'dialog');
    expect(bellBtn).toHaveAttribute('aria-controls', 'notification-panel');
    expect(bellBtn).toHaveAttribute('aria-label', 'Notifications, 2 unread');

    await act(async () => {
      fireEvent.click(bellBtn);
    });

    expect(screen.getByTestId('notification-panel')).toHaveAttribute('id', 'notification-panel');
  });

  test('caps the unread badge at 99+', () => {
    const manyUnread: AppNotification[] = Array.from({ length: 105 }, (_, index) => ({
      id: `many-unread-${index}`,
      type: 'system',
      title: `Notification ${index}`,
      message: `Message ${index}`,
      timestamp: new Date().toISOString(),
      read: false,
    }));

    renderBellWithProvider(manyUnread);

    expect(screen.getByTestId('notification-badge')).toHaveTextContent('99+');
    expect(screen.getByTestId('notification-bell-btn')).toHaveAttribute(
      'aria-label',
      'Notifications, 105 unread'
    );
  });
});
