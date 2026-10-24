import React, { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CheckCircle2, AlertCircle, Coins, Bot, Bell, ChevronRight } from 'lucide-react';
import type { AppNotification, NotificationType } from '../../types/notification';
import { formatRelativeTime } from '../../utils/time';

export const NOTIFICATION_TITLE_MAX_LENGTH = 40;

export function truncateNotificationTitle(title: string, maxLength = NOTIFICATION_TITLE_MAX_LENGTH): string {
  if (title.length <= maxLength) return title;
  return `${title.slice(0, maxLength)}...`;
}

interface NotificationItemProps {
  notification: AppNotification;
  onMarkAsRead: (id: string) => void;
  onClose?: () => void;
}

const getNotificationIcon = (type: NotificationType) => {
  switch (type) {
    case 'payment_failed':
      return <AlertCircle className="notification-icon-error notification-icon-critical" size={18} />;
    case 'task_completed':
    case 'task':
      return <CheckCircle2 className="notification-icon-task" size={18} />;
    case 'task_failed':
      return <AlertCircle className="notification-icon-error" size={18} />;
    case 'payment_received':
    case 'payment':
      return <Coins className="notification-icon-payment" size={18} />;
    case 'agent_registered':
    case 'agent':
      return <Bot className="notification-icon-agent" size={18} />;
    case 'system':
    default:
      return <Bell className="notification-icon-system" size={18} />;
  }
};

export const NotificationItem: React.FC<NotificationItemProps> = ({
  notification,
  onMarkAsRead,
  onClose,
}) => {
  const navigate = useNavigate();
  const touchStartX = useRef<number | null>(null);

  const handleClick = () => {
    if (!notification.read) {
      onMarkAsRead(notification.id);
    }
    if (notification.link) {
      navigate(notification.link);
      onClose?.();
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current !== null) {
      const deltaX = e.changedTouches[0].clientX - touchStartX.current;
      if (Math.abs(deltaX) > 40) {
        onMarkAsRead(notification.id);
      }
      touchStartX.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  const messageText = notification.message || notification.description || '';
  const isCritical = notification.critical || notification.type === 'payment_failed';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      transition={{ duration: 0.2 }}
      className={`notification-item ${notification.read ? 'read' : 'unread'} ${isCritical ? 'critical' : ''} ${notification.type}`}
      onClick={handleClick}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-label={`${notification.title}: ${messageText}`}
      data-testid={`notification-item-${notification.id}`}
    >
      <div className={`notification-icon-wrapper ${notification.type} ${isCritical ? 'critical' : ''}`}>
        {getNotificationIcon(notification.type)}
      </div>

      <div className="notification-content">
        <div className="notification-header-row">
          <span className="notification-title" title={notification.title}>
            {truncateNotificationTitle(notification.title)}
          </span>
          <span className="notification-time">
            {formatRelativeTime(notification.timestamp)}
          </span>
        </div>

        {messageText && <p className="notification-description">{messageText}</p>}

        {notification.link && (
          <div className="notification-link-hint">
            <span>View details</span>
            <ChevronRight size={12} />
          </div>
        )}
      </div>

      {!notification.read && (
        <span className="notification-unread-dot" title="Unread" />
      )}
    </motion.div>
  );
};

export default NotificationItem;
