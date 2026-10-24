import { useState, useId } from 'react';
import { HelpCircle } from 'lucide-react';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { Tooltip } from './Tooltip';
import styles from './HelpIcon.module.css';

export interface HelpIconProps {
  /** Help text to display (max 100 characters) */
  content: string;
  /** Optional label for the button (screen readers) */
  label?: string;
  /** Tooltip placement (default: top) */
  placement?: 'top' | 'bottom';
}

/**
 * A small `?` icon button that shows a tooltip on hover/focus (desktop) or
 * an expandable inline info panel on mobile/touch devices.
 *
 * Usage:
 *   <span>XLM <HelpIcon content="Stellar Lumens — the native currency of the Stellar blockchain" /></span>
 */
export function HelpIcon({ content, label = 'Help', placement = 'top' }: HelpIconProps) {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

  // On mobile: toggle an inline info panel instead of a tooltip
  if (isMobile) {
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }}>
        <button
          type="button"
          className={styles.helpIcon}
          aria-label={label}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((v) => !v)}
        >
          <HelpCircle size={12} aria-hidden="true" />
        </button>
        <span
          id={panelId}
          className={expanded ? styles.mobilePanel : `${styles.mobilePanel} ${styles.mobilePanelHidden}`}
          role="note"
        >
          {content}
        </span>
      </span>
    );
  }

  // Desktop: tooltip on hover/focus
  return (
    <Tooltip content={content} placement={placement}>
      <button
        type="button"
        className={styles.helpIcon}
        aria-label={label}
        tabIndex={0}
      >
        <HelpCircle size={12} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

// ── Pre-defined help entries for blockchain terminology ────────────────────────

/** Reusable HelpIcon instances for standard blockchain terms used across the app. */
export const GlossaryHelp = {
  XLM: () => (
    <HelpIcon
      content="Stellar Lumens — the native currency of the Stellar blockchain"
      label="What is XLM?"
    />
  ),
  Escrow: () => (
    <HelpIcon
      content="Funds locked in a smart contract until work is completed"
      label="What is Escrow?"
    />
  ),
  Bond: () => (
    <HelpIcon
      content="XLM deposited by agents as collateral against poor performance"
      label="What is a Bond/Stake?"
    />
  ),
  CoordinatorAgent: () => (
    <HelpIcon
      content="The AI that breaks your task into sub-tasks and assigns them"
      label="What is a Coordinator Agent?"
    />
  ),
  Gas: () => (
    <HelpIcon
      content="Small XLM amount paid to the Stellar network per transaction"
      label="What are Gas/Fees?"
    />
  ),
  Capability: () => (
    <HelpIcon
      content="A specific skill an agent has been certified to perform"
      label="What is a Capability?"
    />
  ),
} as const;
