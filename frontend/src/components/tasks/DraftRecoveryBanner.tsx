import React from 'react';
import { FileText, RotateCcw, Trash2 } from 'lucide-react';
import type { TaskDraft } from '../../hooks/useTaskDraft';
import styles from './DraftRecoveryBanner.module.css';

export interface DraftRecoveryBannerProps {
  draft: TaskDraft;
  onRestore: () => void;
  onDiscard: () => void;
}

export const DraftRecoveryBanner: React.FC<DraftRecoveryBannerProps> = ({
  draft,
  onRestore,
  onDiscard,
}) => {
  return (
    <div
      className={styles.banner}
      role="alert"
      aria-live="polite"
      data-testid="draft-recovery-banner"
    >
      <div className={styles.leftSection}>
        <div className={styles.iconWrapper} aria-hidden="true">
          <FileText size={18} />
        </div>
        <div className={styles.textGroup}>
          <h4 className={styles.title}>Unsaved draft found</h4>
          <p className={styles.subtitle}>
            You have an unsaved task draft (Step {draft.currentStep} of 3
            {draft.maxBudgetXLM ? ` • ${draft.maxBudgetXLM.toFixed(2)} XLM` : ''}).
            Restore or Discard?
          </p>
        </div>
      </div>

      <div className={styles.actionGroup}>
        <button
          type="button"
          className={styles.restoreButton}
          onClick={onRestore}
          data-testid="draft-restore-button"
        >
          <RotateCcw size={14} aria-hidden="true" />
          <span>Restore</span>
        </button>
        <button
          type="button"
          className={styles.discardButton}
          onClick={onDiscard}
          data-testid="draft-discard-button"
        >
          <Trash2 size={14} aria-hidden="true" />
          <span>Discard</span>
        </button>
      </div>
    </div>
  );
};

export default DraftRecoveryBanner;
