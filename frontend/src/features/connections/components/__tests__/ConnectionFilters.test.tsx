import { render, screen, fireEvent } from '@testing-library/react';
import ConnectionFiltersComponent from '../ConnectionFilters';
import { buildConnection } from '@/test-utils';
import { describe, it, expect, vi } from 'vitest';

describe('ConnectionFiltersComponent', () => {
  const mockConnections = [
    buildConnection({ id: 'c1', location: 'New York', company: 'Google' }),
    buildConnection({ id: 'c2', location: 'San Francisco', company: 'Meta' }),
  ];

  const mockFilters = {};
  const mockOnFiltersChange = vi.fn();

  it('should render filter button', () => {
    render(
      <ConnectionFiltersComponent
        connections={mockConnections}
        filters={mockFilters}
        onFiltersChange={mockOnFiltersChange}
      />
    );

    expect(screen.getByRole('button', { name: /filters/i })).toBeInTheDocument();
  });

  it('should show active filter badges', () => {
    const activeFilters = { location: 'New York', company: 'Google' };
    render(
      <ConnectionFiltersComponent
        connections={mockConnections}
        filters={activeFilters}
        onFiltersChange={mockOnFiltersChange}
      />
    );

    expect(screen.getByText('New York')).toBeInTheDocument();
    expect(screen.getByText('Google')).toBeInTheDocument();
  });

  it('should call onFiltersChange when clearing an individual filter', () => {
    const activeFilters = { location: 'New York' };
    render(
      <ConnectionFiltersComponent
        connections={mockConnections}
        filters={activeFilters}
        onFiltersChange={mockOnFiltersChange}
      />
    );

    const clearBtn = screen.getByRole('button', { name: '' }); // The X button
    fireEvent.click(clearBtn);

    expect(mockOnFiltersChange).toHaveBeenCalledWith({});
  });

  it('should calculate filter stats correctly', async () => {
    render(
      <ConnectionFiltersComponent
        connections={mockConnections}
        filters={mockFilters}
        onFiltersChange={mockOnFiltersChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /filters/i }));

    expect(screen.getByText('Location')).toBeInTheDocument();
    expect(screen.getByText('Company')).toBeInTheDocument();
  });

  it('should call onFiltersChange when updating search term', () => {
    render(
      <ConnectionFiltersComponent
        connections={mockConnections}
        filters={mockFilters}
        onFiltersChange={mockOnFiltersChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /filters/i }));

    const searchInput = screen.getByPlaceholderText(/search by name/i);
    fireEvent.change(searchInput, { target: { value: 'John' } });

    expect(mockOnFiltersChange).toHaveBeenCalledWith({ searchTerm: 'John' });
  });

  it('should show conversion likelihood filter when isNewConnection is true', () => {
    const connectionsWithConversion = [
      ...mockConnections,
      buildConnection({ id: 'c3', conversion_likelihood: 'high' }),
    ];

    render(
      <ConnectionFiltersComponent
        connections={connectionsWithConversion}
        filters={mockFilters}
        onFiltersChange={mockOnFiltersChange}
        isNewConnection={true}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    expect(screen.getByText('Conversion Likelihood')).toBeInTheDocument();
  });

  it('should call onFiltersChange when clearing all filters', () => {
    render(
      <ConnectionFiltersComponent
        connections={mockConnections}
        filters={{ location: 'NY' }}
        onFiltersChange={mockOnFiltersChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByText('Clear All'));

    expect(mockOnFiltersChange).toHaveBeenCalledWith({});
  });
});
