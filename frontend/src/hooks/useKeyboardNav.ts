/**
 * useKeyboardNav
 *
 * Provides arrow-key, Home/End, and Enter/Space keyboard navigation for
 * list-like interactive widgets: menus, dropdowns, filter chip groups,
 * and tab bars.
 *
 * Follows the ARIA Authoring Practices Guide (APG) roving tabindex pattern:
 * only the active item has tabIndex=0; all others use tabIndex=-1.
 * This keeps the tab stop count predictable for keyboard users.
 *
 * Usage
 * -----
 *   const { activeIndex, getItemProps } = useKeyboardNav({
 *     count: items.length,
 *     orientation: 'horizontal',   // 'vertical' | 'horizontal' | 'both'
 *     onActivate: (i) => handleSelect(items[i]),
 *   });
 *
 *   return (
 *     <div role="toolbar" aria-label="Filter options">
 *       {items.map((item, i) => (
 *         <button key={item.id} {...getItemProps(i)}>
 *           {item.label}
 *         </button>
 *       ))}
 *     </div>
 *   );
 *
 * Issue: #101
 */

import { useCallback, useState } from 'react';

export type NavOrientation = 'horizontal' | 'vertical' | 'both';

export interface UseKeyboardNavOptions {
  /** Total number of navigable items. */
  count: number;
  /** Which arrow keys move focus. Default: 'both'. */
  orientation?: NavOrientation;
  /** Whether navigation wraps at boundaries. Default: true. */
  wrap?: boolean;
  /**
   * Called when the user presses Enter or Space on the active item.
   * Receives the activated index.
   */
  onActivate?: (index: number) => void;
  /** Initial active index. Default: 0. */
  initialIndex?: number;
}

export interface UseKeyboardNavReturn {
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  /**
   * Returns props to spread onto each navigable item.
   * Handles tabIndex, onKeyDown, onFocus.
   */
  getItemProps: (index: number) => {
    tabIndex: number;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onFocus: () => void;
    'data-nav-index': number;
  };
}

export function useKeyboardNav({
  count,
  orientation = 'both',
  wrap = true,
  onActivate,
  initialIndex = 0,
}: UseKeyboardNavOptions): UseKeyboardNavReturn {
  const [activeIndex, setActiveIndex] = useState(initialIndex);

  const clamp = useCallback(
    (i: number): number => {
      if (wrap) {
        if (i < 0) return count - 1;
        if (i >= count) return 0;
        return i;
      }
      return Math.max(0, Math.min(i, count - 1));
    },
    [count, wrap],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      const usesVertical = orientation === 'vertical' || orientation === 'both';
      const usesHorizontal = orientation === 'horizontal' || orientation === 'both';

      let next = index;

      switch (e.key) {
        case 'ArrowDown':
          if (!usesVertical) return;
          e.preventDefault();
          next = clamp(index + 1);
          break;
        case 'ArrowUp':
          if (!usesVertical) return;
          e.preventDefault();
          next = clamp(index - 1);
          break;
        case 'ArrowRight':
          if (!usesHorizontal) return;
          e.preventDefault();
          next = clamp(index + 1);
          break;
        case 'ArrowLeft':
          if (!usesHorizontal) return;
          e.preventDefault();
          next = clamp(index - 1);
          break;
        case 'Home':
          e.preventDefault();
          next = 0;
          break;
        case 'End':
          e.preventDefault();
          next = count - 1;
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          onActivate?.(index);
          return;
        default:
          return;
      }

      setActiveIndex(next);
      // Move DOM focus to the newly active item
      const container = (e.currentTarget as HTMLElement).closest('[role]');
      if (container) {
        const el = container.querySelector<HTMLElement>(`[data-nav-index="${next}"]`);
        el?.focus();
      }
    },
    [clamp, count, onActivate, orientation],
  );

  const getItemProps = useCallback(
    (index: number) => ({
      tabIndex: index === activeIndex ? 0 : -1,
      onKeyDown: (e: React.KeyboardEvent) => handleKeyDown(e, index),
      onFocus: () => setActiveIndex(index),
      'data-nav-index': index,
    }),
    [activeIndex, handleKeyDown],
  );

  return { activeIndex, setActiveIndex, getItemProps };
}
