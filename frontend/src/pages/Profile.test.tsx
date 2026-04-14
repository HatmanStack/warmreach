import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Profile from './Profile';
import { createAuthenticatedWrapper } from '@/test-utils';
import * as csvExport from '@/features/connections/utils/csvExport';

// Mock the activity API service to prevent network calls
vi.mock('@/shared/services/activityApiService', () => ({
  activityApiService: {
    getActivityTimeline: vi.fn().mockResolvedValue({
      activities: [],
      nextCursor: null,
      count: 0,
    }),
  },
}));

vi.mock('@/features/connections/utils/csvExport', () => ({
  exportConnectionsCsv: vi.fn(),
}));

vi.mock('@/features/connections/utils/jsonExport', () => ({
  exportConnectionsJson: vi.fn(),
}));

describe('Profile page', () => {
  const AuthenticatedWrapper = createAuthenticatedWrapper();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderProfile = () =>
    render(
      <AuthenticatedWrapper>
        <Profile />
      </AuthenticatedWrapper>
    );

  it('should render the export section with both CSV and JSON buttons', () => {
    renderProfile();
    expect(screen.getByTestId('export-section')).toBeInTheDocument();
    expect(screen.getByTestId('export-csv-button')).toBeInTheDocument();
    expect(screen.getByTestId('export-json-button')).toBeInTheDocument();
  });

  it('should render the activity timeline section', () => {
    renderProfile();
    expect(screen.getByTestId('activity-section')).toBeInTheDocument();
    expect(screen.getByTestId('activity-timeline')).toBeInTheDocument();
  });

  it('should disable export button when no cached connections', () => {
    renderProfile();
    const exportButton = screen.getByTestId('export-csv-button');
    expect(exportButton).toBeDisabled();
    fireEvent.click(exportButton);
    expect(csvExport.exportConnectionsCsv).not.toHaveBeenCalled();
  });

  it('should show message when no cached connections', () => {
    renderProfile();
    expect(
      screen.getByText('Visit the Dashboard first to load your connections.')
    ).toBeInTheDocument();
  });
});
