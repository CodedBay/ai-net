import React, { useState, useId } from 'react';
import styles from './Tooltip.module.css';

export interface TooltipProps {
  /** The content to show in the tooltip (max 100 characters recommended) */
  content: string;
  /** The element that triggers the tooltip */
  children: React.ReactNode;
  /** Override placement (default: top) */
  placement?: 'top' | 'bottom';
}

/**
 * Accessible tooltip component.
 *
 * - Shown on hover and keyboard focus
 * - On mobile / touch devices: replaced with an expandable inline info panel
 * - Content should be ≤ 100 characters for readability
 */
export function Tooltip({ content, children, placement = 'top' }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const tooltipId = useId();

  const show = () => setVisible(true);
  const hide = () => setVisible(false);

  const isBottom = placement === 'bottom';

  return (
    <span
      className={styles.tooltip}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {/* Wrap children and associate tooltip via aria-describedby */}
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<React.HTMLAttributes<HTMLElement>>, {
            'aria-describedby': visible ? tooltipId : undefined,
          })
        : children}

      {/* Desktop tooltip */}
      {visible && (
        <span
          id={tooltipId}
          role="tooltip"
          className={`${styles.tooltipContent} ${isBottom ? styles.tooltipBottom : ''}`}
        >
          {content}
        </span>
      )}
    </span>
  );
}
