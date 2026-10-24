import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, XCircle, AlertTriangle, Info } from 'lucide-react';
import './Toast.css';
import type { Toast, ToastAction } from '../../context/ToastContext';

interface ToastContainerProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

const icons: Record<Toast['type'], React.ReactNode> = {
  success: <CheckCircle size={18} aria-hidden />,
  error: <XCircle size={18} aria-hidden />,
  warning: <AlertTriangle size={18} aria-hidden />,
  info: <Info size={18} aria-hidden />,
};

interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const { t } = useTranslation();
  const pausedAt = useRef<number | null>(null);
  const remaining = useRef<number>(toast.duration);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startTimer = useCallback(() => {
    if (remaining.current <= 0) return;
    timerRef.current = setTimeout(() => onDismiss(toast.id), remaining.current);
  }, [onDismiss, toast.id]);

  const handleMouseEnter = () => {
    // Pause auto-dismiss by recording the time of hover
    pausedAt.current = Date.now();
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const handleMouseLeave = () => {
    if (pausedAt.current !== null) {
      const elapsed = Date.now() - pausedAt.current;
      remaining.current = Math.max(0, remaining.current - elapsed);
      pausedAt.current = null;
    }
    startTimer();
  };

  const handleActionClick = (action: ToastAction) => {
    action.onClick();
    onDismiss(toast.id);
  };

  // error toasts should use role="alert" for assertive announcement
  const role = toast.type === 'error' ? 'alert' : 'status';

  return (
    <div
      className={`toast toast--${toast.type}`}
      role={role}
      aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <span className="toast__icon" aria-hidden="true">
        {icons[toast.type]}
      </span>

      <span className="toast__message">
        {toast.message}
        {toast.count && toast.count > 1 && (
          <span className="toast__count" aria-label={`${toast.count} occurrences`}>
            {' '}
            ×{toast.count}
          </span>
        )}
      </span>

      {toast.action && (
        <button
          type="button"
          className="toast__action"
          onClick={() => handleActionClick(toast.action!)}
        >
          {toast.action.label}
        </button>
      )}

      <button
        type="button"
        className="toast__dismiss"
        onClick={() => onDismiss(toast.id)}
        aria-label={t('a11y.dismissNotification')}
      >
        ×
      </button>
    </div>
  );
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  return (
    <div className="toast-container" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
