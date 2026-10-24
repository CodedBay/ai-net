import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import styles from './ConfirmDialog.module.css';

export interface ConfirmDialogProps {
  /** Whether the dialog is visible */
  open: boolean;
  /** Short title displayed in the dialog heading */
  title: string;
  /** Main explanation of what the action does */
  description: string;
  /** Explicit consequence statement (shown in warning box) */
  consequence?: string;
  /** Label for the dismiss button (default: 'Cancel') */
  cancelLabel?: string;
  /** Label for the danger confirm button */
  confirmLabel: string;
  /** Called when the user explicitly confirms the action */
  onConfirm: () => void;
  /** Called when the dialog is dismissed (Cancel or Escape) */
  onCancel: () => void;
}

/**
 * Accessible confirmation dialog for destructive actions.
 *
 * Keyboard behaviour:
 *  - Escape   → dismisses (calls onCancel)
 *  - Enter    → does NOT confirm (safe default; user must click Confirm)
 *  - Tab      → cycles focus within dialog (focus trap)
 *
 * Focus behaviour:
 *  - On open, focus moves to the Cancel button (safe default)
 *  - On close, focus returns to the element that opened the dialog
 */
export function ConfirmDialog({
  open,
  title,
  description,
  consequence,
  cancelLabel = 'Cancel',
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const containerRef = useFocusTrap<HTMLDivElement>(open);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  // Move focus to Cancel button (safe default) when dialog opens
  useEffect(() => {
    if (open) {
      // Small delay lets the focus trap initialise first
      const id = setTimeout(() => cancelBtnRef.current?.focus(), 10);
      return () => clearTimeout(id);
    }
  }, [open]);

  // Escape → cancel; block Enter from confirming
  useEffect(() => {
    if (!open) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
      // Prevent Enter from submitting / triggering the confirm button
      if (e.key === 'Enter') {
        const target = e.target as HTMLElement;
        // Only block Enter when it would activate the confirm button
        if (target === containerRef.current?.querySelector('[data-confirm]')) {
          e.preventDefault();
        }
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onCancel, containerRef]);

  if (!open) return null;

  const dialogId = 'confirm-dialog';
  const titleId = `${dialogId}-title`;
  const descId = `${dialogId}-desc`;

  return (
    <div className={styles.overlay} onClick={onCancel}>
      {/* Stop overlay click from closing dialog when clicking inside it */}
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className={styles.dialog}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.iconWrap} aria-hidden="true">
          <AlertTriangle size={24} />
        </div>

        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>

        <p id={descId} className={styles.body}>
          {description}
        </p>

        {consequence && (
          <p className={styles.consequence} role="note">
            {consequence}
          </p>
        )}

        <div className={styles.actions}>
          <button
            ref={cancelBtnRef}
            type="button"
            className={styles.cancelBtn}
            onClick={onCancel}
            data-testid="confirm-dialog-cancel"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={styles.confirmBtn}
            onClick={onConfirm}
            data-confirm="true"
            data-testid="confirm-dialog-confirm"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
