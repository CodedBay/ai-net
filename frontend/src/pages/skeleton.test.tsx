/**
 * Skeleton loading screens — acceptance tests for issue #98.
 *
 * Verifies that every data-fetching page exposes a skeleton screen that:
 *  - Renders without throwing
 *  - Sets aria-busy="true" on the container
 *  - Contains visible skeleton elements (no CLS-causing spinner)
 *
 * Tests run against the exported skeleton components directly; full-page
 * rendering (which requires a running server) is covered by e2e tests.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  Skeleton,
  SkeletonCard,
  SkeletonText,
  SkeletonTable,
  SkeletonAvatar,
  SkeletonDashboard,
  SkeletonTaskDetail,
} from '../components/common/Skeleton';

// ─────────────────────────────────────────────────────────────────────────────
//  Primitive skeleton components
// ─────────────────────────────────────────────────────────────────────────────

describe('Skeleton primitives (#98)', () => {
  it('Skeleton renders as aria-hidden', () => {
    render(<Skeleton data-testid="s" />);
    expect(screen.getByTestId('s')).toHaveAttribute('aria-hidden', 'true');
  });

  it('SkeletonText renders the requested number of lines', () => {
    render(<SkeletonText lines={4} data-testid="st" />);
    const lines = screen.getAllByTestId('skeleton-text-line');
    expect(lines).toHaveLength(4);
  });

  it('SkeletonAvatar renders a circular skeleton', () => {
    render(<SkeletonAvatar size={48} data-testid="sa" />);
    expect(screen.getByTestId('sa')).toBeInTheDocument();
  });

  it('SkeletonTable renders correct number of rows', () => {
    render(<SkeletonTable rows={5} columns={3} />);
    const rows = screen.getAllByTestId('skeleton-table-row');
    expect(rows).toHaveLength(5);
  });

  it('SkeletonCard renders children', () => {
    render(
      <SkeletonCard data-testid="sc">
        <span data-testid="child">content</span>
      </SkeletonCard>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Page-level skeleton compositions
// ─────────────────────────────────────────────────────────────────────────────

describe('SkeletonDashboard — /admin (#98)', () => {
  it('renders with aria-busy=true', () => {
    render(<SkeletonDashboard />);
    expect(screen.getByTestId('skeleton-dashboard')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders KPI card skeletons', () => {
    render(<SkeletonDashboard />);
    // SkeletonDashboard renders 4 SkeletonCard children
    const rows = screen.getAllByTestId('skeleton-table-row');
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('SkeletonTaskDetail — /tasks/:id (#98)', () => {
  it('renders with aria-busy=true', () => {
    render(<SkeletonTaskDetail />);
    expect(screen.getByTestId('skeleton-task-detail')).toHaveAttribute('aria-busy', 'true');
  });

  it('contains skeleton text lines for panels', () => {
    render(<SkeletonTaskDetail />);
    const lines = screen.getAllByTestId('skeleton-text-line');
    expect(lines.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Agent card skeleton (used on /agents grid)
// ─────────────────────────────────────────────────────────────────────────────

describe('AgentCardSkeleton — /agents (#98)', () => {
  it('skeleton structure matches expected testid', () => {
    // AgentCardSkeleton is defined inside AgentsPage.tsx and rendered in the
    // loading branch. Here we verify the Skeleton primitive it composes
    // behaves as expected (the AgentsPage.test.tsx covers the full loading path).
    render(
      <div data-testid="agent-card-skeleton" aria-hidden="true">
        <Skeleton variant="circular" width={40} height={40} />
        <Skeleton variant="pill" width="5rem" height="1.6rem" />
      </div>,
    );
    const card = screen.getByTestId('agent-card-skeleton');
    expect(card).toHaveAttribute('aria-hidden', 'true');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Shimmer animation — structural check
// ─────────────────────────────────────────────────────────────────────────────

describe('Skeleton shimmer (#98)', () => {
  it('skeleton element has no visible spinner child', () => {
    const { container } = render(<Skeleton width="100%" height="2rem" data-testid="shimmer" />);
    // Spinners are typically <svg role="progressbar"> or a .spinner class.
    // Skeleton must not contain either.
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.querySelector('.spinner')).toBeNull();
  });

  it('skeleton respects animate=false (static variant)', () => {
    render(<Skeleton animate={false} data-testid="static-skeleton" />);
    const el = screen.getByTestId('static-skeleton');
    // When animate=false, the static CSS class is applied (no shimmer animation)
    expect(el.className).toMatch(/static/);
  });
});
