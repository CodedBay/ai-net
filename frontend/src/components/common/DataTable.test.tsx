import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataTable } from './DataTable';

describe('DataTable', () => {
  const rows = [
    { id: 'a', name: 'Alpha', score: 2 },
    { id: 'b', name: 'Bravo', score: 10 },
    { id: 'c', name: 'Charlie', score: 7 },
  ];

  it('renders rows and sorts a column', async () => {
    const user = userEvent.setup();

    render(
      <DataTable
        columns={[
          { key: 'name', header: 'Name' },
          { key: 'score', header: 'Score', sortable: true },
        ]}
        rows={rows}
        getRowKey={(row) => row.id}
      />
    );

    expect(screen.getByText('Alpha')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /score/i }));

    const cells = screen.getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('2');
  });

  it('moves row focus with arrow keys and activates clickable rows', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();

    render(
      <DataTable
        columns={[{ key: 'name', header: 'Name' }]}
        rows={rows}
        getRowKey={(row) => row.id}
        onRowClick={onRowClick}
      />
    );

    const [, firstRow, secondRow] = screen.getAllByRole('row');
    firstRow.focus();
    await user.keyboard('{ArrowDown}{Enter}');

    expect(secondRow).toHaveFocus();
    expect(onRowClick).toHaveBeenCalledWith(rows[1]);
  });

  it('exposes mobile priorities and card presentation for responsive layouts', () => {
    render(
      <DataTable
        columns={[
          { key: 'name', header: 'Name', priority: 'primary' },
          { key: 'score', header: 'Score', priority: 'hidden-mobile' },
        ]}
        rows={rows}
        getRowKey={(row) => row.id}
        mobileView="cards"
      />
    );

    const table = screen.getByRole('table');
    expect(table).toHaveAttribute('data-mobile-view', 'cards');
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('data-priority', 'primary');
    expect(screen.getByRole('cell', { name: '2' })).toHaveAttribute('data-priority', 'hidden-mobile');
  });
});
