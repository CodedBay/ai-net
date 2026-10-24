import React, { useEffect, useRef, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCheck, Inbox, Trash2, X } from 'lucide-react';
import { useNotifications } from '../../hooks/useNotifications';
import NotificationItem from './NotificationItem';
import type { AppNotification } from '../../types/notification';
import './NotificationCenter.css';

export interface NotificationPanelProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement>;
}

export type NotificationFilterTab = 'all' | 'payments' | 'tasks' | 'system';

interface GroupedNotifications {
  today: AppNotification[];
  yesterday: AppNotification[];
  earlier: AppNotification[];
}

function groupNotifications(items: AppNotification[]): GroupedNotifications {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;

  const today: AppNotification[] = [];
  const yesterday: AppNotification[] = [];
  const earlier: AppNotification[] = [];

  for (const item of items) {
    const time = new Date(item.timestamp).getTime();
    if (time >= startOfToday) {
      today.push(item);
    } else if (time >= startOfYesterday) {
      yesterday.push(item);
    } else {
      earlier.push(item);
    }
  }

  return { today, yesterday, earlier };
}

export const NotificationPanel: React.FC<NotificationPanelProps> = ({
  isOpen,
  onClose,
  anchorRef,
}) => {
  const { notifications, unreadCount, markAsRead, markAllAsRead, clearAll } = useNotifications();
  const [activeTab, setActiveTab] = useState<NotificationFilterTab>('all');
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current && !panelRef.current.contains(target)) {
        if (anchorRef?.current && anchorRef.current.contains(target)) {
          return;
        }
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose, anchorRef]);

  // Sort notifications newest first
  const sortedNotifications = useMemo(() => {
    return [...notifications].sort((a, b) => {
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });
  }, [notifications]);

  // Filter tabs
  const filteredNotifications = useMemo(() => {
    return sortedNotifications.filter((n) => {
      if (activeTab === 'all') return true;
      if (activeTab === 'payments') {
        return (
          n.type === 'payment' ||
          n.type === 'payment_received' ||
          n.type === 'payment_failed' ||
          n.type === 'payment_locked'
        );
      }
      if (activeTab === 'tasks') {
        return (
          n.type === 'task' ||
          n.type === 'task_completed' ||
          n.type === 'task_failed'
        );
      }
      if (activeTab === 'system') {
        return (
          n.type === 'system' ||
          n.type === 'agent' ||
          n.type === 'agent_registered'
        );
      }
      return true;
    });
  }, [sortedNotifications, activeTab]);

  const groups = useMemo(() => groupNotifications(filteredNotifications), [filteredNotifications]);

  const filterTabs: { id: NotificationFilterTab; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'payments', label: 'Payments' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'system', label: 'System' },
  ];

  const hasAnyItems = filteredNotifications.length > 0;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Mobile slide-over backdrop */}
          <motion.div
            className="notification-panel-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden="true"
          />

          <motion.div
            ref={panelRef}
            className="notification-panel slide-over"
            initial={{ opacity: 0, x: 20, y: 0 }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            exit={{ opacity: 0, x: 20, y: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            role="dialog"
            aria-label="Notification Center"
            data-testid="notification-panel"
          >
            {/* Header */}
            <div className="notification-panel-header">
              <div className="notification-panel-title-group">
                <span className="notification-panel-title">Notifications</span>
                {unreadCount > 0 && (
                  <span className="notification-unread-count-pill" data-testid="panel-unread-badge">
                    {unreadCount} new
                  </span>
                )}
              </div>

              <div className="notification-panel-actions">
                {unreadCount > 0 && (
                  <button
                    type="button"
                    className="mark-all-read-btn"
                    onClick={markAllAsRead}
                    aria-label="Mark all as read"
                    data-testid="mark-all-read-btn"
                  >
                    <CheckCheck size={14} />
                    <span>Mark all as read</span>
                  </button>
                )}
                {notifications.length > 0 && (
                  <button
                    type="button"
                    className="clear-all-btn"
                    onClick={clearAll}
                    aria-label="Clear all notifications"
                    title="Clear all"
                    data-testid="clear-all-btn"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
                <button
                  type="button"
                  className="notification-close-btn"
                  onClick={onClose}
                  aria-label="Close notifications panel"
                  title="Close"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Filter Tabs */}
            <div className="notification-tabs-bar" role="tablist" aria-label="Filter notifications">
              {filterTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  className={`notification-tab-btn ${activeTab === tab.id ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                  data-testid={`notification-tab-${tab.id}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Body */}
            <div className="notification-panel-body">
              {!hasAnyItems ? (
                <div className="notification-empty-state" data-testid="notification-empty-state">
                  <div className="empty-state-icon-wrapper">
                    <Inbox size={28} className="empty-state-icon" />
                  </div>
                  <p className="empty-state-title">No notifications yet</p>
                  <p className="empty-state-subtitle">We'll alert you when tasks update or payments settle.</p>
                </div>
              ) : (
                <div className="notification-groups-container">
                  {groups.today.length > 0 && (
                    <div className="notification-group">
                      <div className="notification-group-header">
                        <span className="notification-group-title">Today</span>
                        <span className="notification-group-badge">{groups.today.length}</span>
                      </div>
                      <div className="notification-list" role="feed" aria-label="Today's notifications">
                        <AnimatePresence initial={false}>
                          {groups.today.map((notification) => (
                            <NotificationItem
                              key={notification.id}
                              notification={notification}
                              onMarkAsRead={markAsRead}
                              onClose={onClose}
                            />
                          ))}
                        </AnimatePresence>
                      </div>
                    </div>
                  )}

                  {groups.yesterday.length > 0 && (
                    <div className="notification-group">
                      <div className="notification-group-header">
                        <span className="notification-group-title">Yesterday</span>
                        <span className="notification-group-badge">{groups.yesterday.length}</span>
                      </div>
                      <div className="notification-list" role="feed" aria-label="Yesterday's notifications">
                        <AnimatePresence initial={false}>
                          {groups.yesterday.map((notification) => (
                            <NotificationItem
                              key={notification.id}
                              notification={notification}
                              onMarkAsRead={markAsRead}
                              onClose={onClose}
                            />
                          ))}
                        </AnimatePresence>
                      </div>
                    </div>
                  )}

                  {groups.earlier.length > 0 && (
                    <div className="notification-group">
                      <div className="notification-group-header">
                        <span className="notification-group-title">Earlier</span>
                        <span className="notification-group-badge">{groups.earlier.length}</span>
                      </div>
                      <div className="notification-list" role="feed" aria-label="Earlier notifications">
                        <AnimatePresence initial={false}>
                          {groups.earlier.map((notification) => (
                            <NotificationItem
                              key={notification.id}
                              notification={notification}
                              onMarkAsRead={markAsRead}
                              onClose={onClose}
                            />
                          ))}
                        </AnimatePresence>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default NotificationPanel;
