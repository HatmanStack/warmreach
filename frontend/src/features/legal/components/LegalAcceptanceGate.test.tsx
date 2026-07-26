import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mockAccept = vi.fn();
let mockState: {
  outstanding: Array<{ documentId: string; title: string; version: string }>;
  allAccepted: boolean;
  isLoading: boolean;
  isAccepting: boolean;
  acceptError: Error | null;
  isAuthenticated: boolean;
  isError: boolean;
  isFetching: boolean;
};

const mockRetry = vi.fn();

vi.mock('../hooks/useLegalAcceptance', () => ({
  useLegalAcceptance: () => ({
    ...mockState,
    accepted: {},
    accept: mockAccept,
    acceptAsync: mockAccept,
    retry: mockRetry,
  }),
}));

import { LegalAcceptanceGate } from './LegalAcceptanceGate';

const RISK = {
  documentId: 'linkedin_risk_disclosure',
  title: 'LinkedIn Automation Risk Disclosure',
  version: '2026-07-26.1',
};
const TERMS = { documentId: 'terms_of_use', title: 'Terms of Use', version: '2026-07-26.1' };

describe('LegalAcceptanceGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState = {
      outstanding: [RISK],
      allAccepted: false,
      isLoading: false,
      isAccepting: false,
      acceptError: null,
      isAuthenticated: true,
      isError: false,
      isFetching: false,
    };
  });

  it('shows nothing once everything is accepted', () => {
    mockState = { ...mockState, outstanding: [], allAccepted: true };

    render(<LegalAcceptanceGate />);

    expect(screen.queryByTestId('legal-acceptance-gate')).not.toBeInTheDocument();
  });

  it('stays visible with a retry when the status load fails', () => {
    // The server still refuses every LinkedIn action, so hiding the gate here
    // strands the user behind a 403 with no explanation and no way forward.
    mockState = { ...mockState, isError: true, outstanding: [], allAccepted: false };

    render(<LegalAcceptanceGate />);

    expect(screen.getByTestId('legal-acceptance-gate')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('legal-retry-button'));
    expect(mockRetry).toHaveBeenCalled();
  });

  it('moves focus into the dialog so the page behind is unreachable', () => {
    // aria-modal alone does neither.
    render(<LegalAcceptanceGate />);

    const dialog = screen.getByTestId('legal-acceptance-gate').querySelector('[tabindex="-1"]');
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(dialog);
  });

  it('shows nothing to a signed-out visitor', () => {
    // The gate is mounted above the router, so it also renders on the landing
    // and sign-in routes. A legal dialog over the sign-in form — and an
    // unauthenticated request behind it — is not the intent.
    mockState = { ...mockState, isAuthenticated: false };

    render(<LegalAcceptanceGate />);

    expect(screen.queryByTestId('legal-acceptance-gate')).not.toBeInTheDocument();
  });

  it('shows nothing while status is still loading', () => {
    // Flashing a legal dialog during page load and then removing it is worse
    // than a moment of nothing.
    mockState = { ...mockState, isLoading: true };

    render(<LegalAcceptanceGate />);

    expect(screen.queryByTestId('legal-acceptance-gate')).not.toBeInTheDocument();
  });

  it('blocks with the document text when something is outstanding', () => {
    render(<LegalAcceptanceGate />);

    expect(screen.getByTestId('legal-acceptance-gate')).toBeInTheDocument();
    expect(screen.getByTestId('legal-document-body')).toBeInTheDocument();
  });

  it('offers no way to dismiss without accepting', () => {
    // An acceptance a user can wave away is an acceptance record that means
    // nothing — worse than not asking.
    render(<LegalAcceptanceGate />);

    const dialog = screen.getByTestId('legal-acceptance-gate');
    expect(dialog.querySelector('[aria-label="Close"]')).toBeNull();
    for (const button of Array.from(dialog.querySelectorAll('button'))) {
      expect(button.textContent?.toLowerCase()).not.toMatch(/close|cancel|later|skip|dismiss/);
    }
  });

  it('will not accept until the box is ticked', () => {
    render(<LegalAcceptanceGate />);

    const button = screen.getByTestId('legal-accept-button');
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('accepts every outstanding document once confirmed', () => {
    mockState = { ...mockState, outstanding: [RISK, TERMS] };

    render(<LegalAcceptanceGate />);
    fireEvent.click(screen.getByTestId('legal-confirm-checkbox'));
    fireEvent.click(screen.getByTestId('legal-accept-button'));

    expect(mockAccept).toHaveBeenCalledWith(['linkedin_risk_disclosure', 'terms_of_use']);
  });

  it('states the ban risk in the confirmation itself', () => {
    // The checkbox label is what a user actually reads before ticking; the risk
    // must be there, not only buried in the document body.
    render(<LegalAcceptanceGate />);

    // Scoped to the label, not the document body — the point is that the risk
    // is restated at the moment of consent, not only 2,000 words above it.
    const label = screen.getByTestId('legal-confirm-checkbox').closest('label');
    expect(label).not.toBeNull();
    expect(label!.textContent).toMatch(/permanently banned/i);
    expect(label!.textContent).toMatch(/accept that risk/i);
  });

  it('lets the user switch between outstanding documents', () => {
    mockState = { ...mockState, outstanding: [RISK, TERMS] };

    render(<LegalAcceptanceGate />);
    fireEvent.click(screen.getByRole('button', { name: 'Terms of Use' }));

    expect(screen.getByText(/Currently viewing: Terms of Use/)).toBeInTheDocument();
  });

  it('surfaces a failure to record acceptance', () => {
    mockState = { ...mockState, acceptError: new Error('nope') };

    render(<LegalAcceptanceGate />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('disables the button while recording', () => {
    mockState = { ...mockState, isAccepting: true };

    render(<LegalAcceptanceGate />);
    fireEvent.click(screen.getByTestId('legal-confirm-checkbox'));

    expect(screen.getByTestId('legal-accept-button')).toBeDisabled();
  });
});
