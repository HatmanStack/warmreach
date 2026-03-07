import { render, screen, fireEvent } from '@testing-library/react';
import ConversationTopicPanel from '../ConversationTopicPanel';
import { describe, it, expect, vi } from 'vitest';

describe('ConversationTopicPanel', () => {
  const defaultProps = {
    topic: '',
    onTopicChange: vi.fn(),
    onGenerateMessages: vi.fn(),
    selectedConnectionsCount: 1,
  };

  it('should render correctly in initial state', () => {
    render(<ConversationTopicPanel {...defaultProps} />);
    expect(screen.getByPlaceholderText(/e.g., AI trends/i)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /generate/i });
    expect(btn).toBeDisabled(); // empty topic
  });

  it('should enable button when topic is present', () => {
    render(<ConversationTopicPanel {...defaultProps} topic="AI" />);
    const btn = screen.getByRole('button', { name: /generate/i });
    expect(btn).not.toBeDisabled();
  });

  it('should show generating state', () => {
    render(
      <ConversationTopicPanel
        {...defaultProps}
        isGenerating={true}
        currentConnectionName="John Doe"
      />
    );
    expect(screen.getByText(/Generating message for John Doe/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });

  it('should call onStopGeneration when generating', () => {
    const onStop = vi.fn();
    render(
      <ConversationTopicPanel {...defaultProps} isGenerating={true} onStopGeneration={onStop} />
    );
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalled();
  });

  it('should call onTopicChange', () => {
    render(<ConversationTopicPanel {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(/e.g., AI trends/i);
    fireEvent.change(textarea, { target: { value: 'New Topic' } });
    expect(defaultProps.onTopicChange).toHaveBeenCalledWith('New Topic');
  });
});
