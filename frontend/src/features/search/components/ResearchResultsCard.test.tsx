import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/shared/components/ui/tooltip';

const mockUsePostComposer = vi.fn();

vi.mock('@/features/posts', () => ({
  usePostComposer: () => mockUsePostComposer(),
}));

import ResearchResultsCard from './ResearchResultsCard';

function setComposer(overrides: Record<string, unknown> = {}) {
  mockUsePostComposer.mockReturnValue({
    researchContent: null,
    researchingIdeas: [],
    includeResearch: true,
    setIncludeResearch: vi.fn(),
    ...overrides,
  });
}

describe('ResearchResultsCard', () => {
  it('shows a Cancel button and the researched topics while in progress', () => {
    setComposer({ researchingIdeas: ['My contrarian topic'] });
    const onCancel = vi.fn();

    render(<ResearchResultsCard isResearching onClear={vi.fn()} onCancel={onCancel} />);

    // getByTitle throws if absent, so this asserts the Cancel button renders.
    fireEvent.click(screen.getByTitle('Cancel research'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    // The in-progress topic is surfaced so the user knows what is researching.
    expect(screen.getByText(/My contrarian topic/)).not.toBeNull();
  });

  it('shows Clear (not Cancel) once research has completed', () => {
    setComposer({ researchContent: 'the results' });

    // The completed view renders the inclusion-toggle tooltip, which needs a
    // Radix TooltipProvider ancestor.
    render(
      <TooltipProvider>
        <ResearchResultsCard isResearching={false} onClear={vi.fn()} onCancel={vi.fn()} />
      </TooltipProvider>
    );

    expect(screen.queryByTitle('Cancel research')).toBeNull();
    expect(screen.getByTitle('Clear research')).not.toBeNull();
  });

  it('renders nothing when idle', () => {
    setComposer();
    const { container } = render(
      <ResearchResultsCard isResearching={false} onClear={vi.fn()} onCancel={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });
});
