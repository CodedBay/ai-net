import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Tooltip } from './Tooltip';

describe('Tooltip', () => {
  it('renders children', () => {
    render(
      <Tooltip content="Stellar Lumens — the native currency of the Stellar blockchain">
        <button>XLM</button>
      </Tooltip>,
    );
    expect(screen.getByText('XLM')).toBeInTheDocument();
  });

  it('does not show tooltip content initially', () => {
    render(
      <Tooltip content="Funds locked in a smart contract until work is completed">
        <button>Escrow</button>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows tooltip on mouse enter', () => {
    render(
      <Tooltip content="Funds locked in a smart contract until work is completed">
        <button>Escrow</button>
      </Tooltip>,
    );
    const wrapper = screen.getByText('Escrow').closest('span')!;
    fireEvent.mouseEnter(wrapper);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Funds locked in a smart contract until work is completed',
    );
  });

  it('hides tooltip on mouse leave', () => {
    render(
      <Tooltip content="Funds locked in a smart contract until work is completed">
        <button>Escrow</button>
      </Tooltip>,
    );
    const wrapper = screen.getByText('Escrow').closest('span')!;
    fireEvent.mouseEnter(wrapper);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.mouseLeave(wrapper);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows tooltip on focus', () => {
    render(
      <Tooltip content="Small XLM amount paid to the Stellar network per transaction">
        <button>Gas</button>
      </Tooltip>,
    );
    const wrapper = screen.getByText('Gas').closest('span')!;
    fireEvent.focus(wrapper);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('hides tooltip on blur', () => {
    render(
      <Tooltip content="Small XLM amount paid to the Stellar network per transaction">
        <button>Gas</button>
      </Tooltip>,
    );
    const wrapper = screen.getByText('Gas').closest('span')!;
    fireEvent.focus(wrapper);
    fireEvent.blur(wrapper);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('sets aria-describedby on child when visible', () => {
    render(
      <Tooltip content="A specific skill an agent has been certified to perform">
        <button>Capability</button>
      </Tooltip>,
    );
    const wrapper = screen.getByText('Capability').closest('span')!;
    fireEvent.mouseEnter(wrapper);
    const btn = screen.getByRole('button', { name: 'Capability' });
    expect(btn).toHaveAttribute('aria-describedby');
  });

  it('tooltip content has role=tooltip', () => {
    render(
      <Tooltip content="XLM deposited by agents as collateral against poor performance">
        <button>Bond</button>
      </Tooltip>,
    );
    const wrapper = screen.getByText('Bond').closest('span')!;
    fireEvent.mouseEnter(wrapper);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });
});
