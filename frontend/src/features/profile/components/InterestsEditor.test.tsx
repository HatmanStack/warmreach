import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InterestsEditor } from './InterestsEditor';

describe('InterestsEditor', () => {
  const defaultProps = {
    interests: ['React', 'TypeScript'],
    newInterest: '',
    onNewInterestChange: vi.fn(),
    onAddInterest: vi.fn(),
    onRemoveInterest: vi.fn(),
  };

  it('renders existing interests as badges', () => {
    render(<InterestsEditor {...defaultProps} />);
    expect(screen.getByText('React')).toBeInTheDocument();
    expect(screen.getByText('TypeScript')).toBeInTheDocument();
  });

  it('renders the input and add button', () => {
    render(<InterestsEditor {...defaultProps} />);
    expect(
      screen.getByPlaceholderText('Add an interest (e.g., Machine Learning)')
    ).toBeInTheDocument();
  });

  it('calls onNewInterestChange when typing', () => {
    const onNewInterestChange = vi.fn();
    render(<InterestsEditor {...defaultProps} onNewInterestChange={onNewInterestChange} />);
    fireEvent.change(screen.getByPlaceholderText('Add an interest (e.g., Machine Learning)'), {
      target: { value: 'Docker' },
    });
    expect(onNewInterestChange).toHaveBeenCalledWith('Docker');
  });

  it('calls onRemoveInterest when remove button is clicked', () => {
    const onRemoveInterest = vi.fn();
    render(<InterestsEditor {...defaultProps} onRemoveInterest={onRemoveInterest} />);
    const reactBadge = screen.getByText('React');
    const removeBtn = reactBadge.parentElement?.querySelector('button');
    if (removeBtn) fireEvent.click(removeBtn);
    expect(onRemoveInterest).toHaveBeenCalledWith('React');
  });

  it('renders heading', () => {
    render(<InterestsEditor {...defaultProps} />);
    expect(screen.getByText('Interests & Expertise')).toBeInTheDocument();
  });
});
