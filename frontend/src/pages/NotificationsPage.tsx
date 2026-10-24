import React from 'react';
import { Bell, CheckCheck, Inbox } from 'lucide-react';
import { useNotifications } from '../hooks/useNotifications';
import NotificationItem from '../components/notifications/NotificationItem';
import '../components/notifications/NotificationCenter.css';

/**
 * NotificationsPage — /notifications
 *
 * Full notification history. The header dropdown intentionally shows only the
 * five most recent items; "View All" sends users here.
 */
export const NotificationsPage: React.FC = () => {
  const { notifications, unreadCount, markAsRead, markAllAsRead } = useNotifications();

  const sortedNotifications = [...notifications].sort((a, b) => {
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  return (
    <div className="notifications-page" data-testid="notifications-page">
      <div className="notifications-page-header">
        <div className="notifications-page-title-group">
          <h1 className="notifications-page-title">
            <Bell size={22} aria-hidden="true" />
            Notifications
          </h1>
          {unreadCount > 0 && (
            <span className="notification-unread-count-pill" data-testid="notifications-page-unread-badge">
              {unreadCount} unread
            </span>
          )}
        </div>

        {unreadCount > 0 && (
          <button
            type="button"
            className="mark-all-read-btn"
            onClick={markAllAsRead}
            aria-label="Mark all as read"
            data-testid="mark-all-read-btn"
          >
            <CheckCheck size={14} aria-hidden="true" />
            <span>Mark all as read</span>
          </button>
        )}
      </div>

      {sortedNotifications.length === 0 ? (
        <div
          className="notifications-page-empty"
          data-testid="notifications-page-empty-state"
        >
          <div className="empty-state-icon-wrapper">
            <Inbox size={28} className="empty-state-icon" aria-hidden="true" />
          </div>
          <p className="empty-state-title">No notifications yet</p>
          <p className="empty-state-subtitle">
            We'll alert you when tasks update or payments settle.
          </p>
        </div>
      ) : (
        <div className="notifications-page-list" role="feed" aria-label="All notifications">
          {sortedNotifications.map((notification) => (
            <NotificationItem
              key={notification.id}
              notification={notification}
              onMarkAsRead={markAsRead}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default NotificationsPage;
