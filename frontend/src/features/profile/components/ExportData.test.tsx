import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExportData } from './ExportData';

describe('ExportData', () => {
  it('renders export section', () => {
    render(<ExportData onExportCsv={vi.fn()} hasConnections={false} />);
    expect(screen.getByTestId('export-section')).toBeInTheDocument();
    expect(screen.getByText('Export Data')).toBeInTheDocument();
  });

  it('disables button when no connections', () => {
    render(<ExportData onExportCsv={vi.fn()} hasConnections={false} />);
    expect(screen.getByTestId('export-csv-button')).toBeDisabled();
  });

  it('enables button when connections exist', () => {
    render(<ExportData onExportCsv={vi.fn()} hasConnections={true} />);
    expect(screen.getByTestId('export-csv-button')).not.toBeDisabled();
  });

  it('calls onExportCsv when button is clicked', () => {
    const onExportCsv = vi.fn();
    render(<ExportData onExportCsv={onExportCsv} hasConnections={true} />);
    fireEvent.click(screen.getByTestId('export-csv-button'));
    expect(onExportCsv).toHaveBeenCalled();
  });

  it('shows message when no connections', () => {
    render(<ExportData onExportCsv={vi.fn()} hasConnections={false} />);
    expect(
      screen.getByText('Visit the Dashboard first to load your connections.')
    ).toBeInTheDocument();
  });

  it('does not show message when connections exist', () => {
    render(<ExportData onExportCsv={vi.fn()} hasConnections={true} />);
    expect(
      screen.queryByText('Visit the Dashboard first to load your connections.')
    ).not.toBeInTheDocument();
  });
});
