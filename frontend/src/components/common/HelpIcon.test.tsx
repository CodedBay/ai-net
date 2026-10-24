import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HelpIcon, GlossaryHelp } from './HelpIcon';

// Mock useMediaQuery to simulate desktop by default
vi.mock('../../hooks/useMediaQuery', () => ({
  useMediaQuery: vi.fn(() => false), // false = desktop
}));

import { useMediaQuery } from '../../hooks/useMediaQuery';

describe('HelpIcon (desktop)', () => {
  beforeEach(() => {
    vi.mocked(useMediaQuery).mockReturnValue(false);
  });

  it('renders a button with the default aria-label', () => {
    render(<HelpIcon content="Stellar Lumens — the native currency of the Stellar blockchain" />);
    expect(screen.getByRole('button', { name: 'Help' })).toBeInTheDocument();
  });

  it('renders a button with a custom aria-label', () => {
    render(
      <HelpIcon
        content="Stellar Lumens — the native currency of the Stellar blockchain"
        label="What is XLM?"
      />,
    );
    expect(screen.getByRole('button', { name: 'What is XLM?' })).toBeInTheDocument();
  });

  it('shows tooltip on hover', () => {
    render(
      <HelpIcon
        content="Funds locked in a smart contract until work is completed"
        label="What is Escrow?"
      />,
    );
    const btn = screen.getByRole('button', { name: 'What is Escrow?' });
    // hover over the tooltip wrapper (parent span)
    fireEvent.mouseEnter(btn.closest('span')!);
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Funds locked in a smart contract until work is completed',
    );
  });
});

describe('HelpIcon (mobile)', () => {
  beforeEach(() => {
    vi.mocked(useMediaQuery).mockReturnValue(true);
  });

  it('renders button with aria-expanded=false initially', () => {
    render(<HelpIcon content="XLM deposited by agents as collateral" label="What is Bond?" />);
    expect(screen.getByRole('button', { name: 'What is Bond?' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('toggles info panel on click', () => {
    render(<HelpIcon content="XLM deposited by agents as collateral" label="What is Bond?" />);
    const btn = screen.getByRole('button', { name: 'What is Bond?' });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    // The panel text should now be visible
    expect(screen.getByText('XLM deposited by agents as collateral')).toBeInTheDocument();
  });

  it('collapses panel on second click', () => {
    render(<HelpIcon content="XLM deposited by agents as collateral" label="What is Bond?" />);
    const btn = screen.getByRole('button', { name: 'What is Bond?' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('does NOT render a tooltip element on mobile', () => {
    render(<HelpIcon content="Some tooltip content" label="Help" />);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('GlossaryHelp presets', () => {
  beforeEach(() => {
    vi.mocked(useMediaQuery).mockReturnValue(false);
  });

  it('GlossaryHelp.XLM renders with correct label', () => {
    const XLMHelp = GlossaryHelp.XLM;
    render(<XLMHelp />);
    expect(screen.getByRole('button', { name: 'What is XLM?' })).toBeInTheDocument();
  });

  it('GlossaryHelp.Escrow renders with correct label', () => {
    const EscrowHelp = GlossaryHelp.Escrow;
    render(<EscrowHelp />);
    expect(screen.getByRole('button', { name: 'What is Escrow?' })).toBeInTheDocument();
  });

  it('GlossaryHelp.Bond renders with correct label', () => {
    const BondHelp = GlossaryHelp.Bond;
    render(<BondHelp />);
    expect(screen.getByRole('button', { name: 'What is a Bond/Stake?' })).toBeInTheDocument();
  });

  it('GlossaryHelp.Gas renders with correct label', () => {
    const GasHelp = GlossaryHelp.Gas;
    render(<GasHelp />);
    expect(screen.getByRole('button', { name: 'What are Gas/Fees?' })).toBeInTheDocument();
  });

  it('GlossaryHelp.Capability renders with correct label', () => {
    const CapHelp = GlossaryHelp.Capability;
    render(<CapHelp />);
    expect(screen.getByRole('button', { name: 'What is a Capability?' })).toBeInTheDocument();
  });
});
