import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ConnectionNotesModal from './ConnectionNotesModal';
import { buildConnection, createAuthenticatedWrapper } from '@/test-utils';
import { notesApiService } from '@/shared/services/notesApiService';

vi.mock('@/shared/services/notesApiService', () => ({
  notesApiService: {
    addNote: vi.fn(),
    updateNote: vi.fn(),
    deleteNote: vi.fn(),
  },
}));

describe('ConnectionNotesModal', () => {
  const AuthenticatedWrapper = createAuthenticatedWrapper();
  const mockOnClose = vi.fn();
  const mockOnNotesChanged = vi.fn();

  const connectionWithNotes = buildConnection({
    id: 'c1',
    first_name: 'John',
    last_name: 'Doe',
    notes: [
      {
        id: 'n1',
        content: 'Met at a conference',
        timestamp: '2024-06-01T10:00:00Z',
        updatedAt: '2024-06-01T10:00:00Z',
      },
      {
        id: 'n2',
        content: 'Interested in AI',
        timestamp: '2024-07-15T10:00:00Z',
        updatedAt: '2024-07-20T10:00:00Z',
      },
    ],
  });

  const connectionNoNotes = buildConnection({
    id: 'c2',
    first_name: 'Jane',
    last_name: 'Smith',
    notes: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render modal with connection name in header', () => {
    render(
      <AuthenticatedWrapper>
        <ConnectionNotesModal
          isOpen={true}
          onClose={mockOnClose}
          connection={connectionWithNotes}
        />
      </AuthenticatedWrapper>
    );

    expect(screen.getByText(/Notes - John Doe/)).toBeInTheDocument();
  });

  it('should display notes sorted by timestamp descending', () => {
    render(
      <AuthenticatedWrapper>
        <ConnectionNotesModal
          isOpen={true}
          onClose={mockOnClose}
          connection={connectionWithNotes}
        />
      </AuthenticatedWrapper>
    );

    const noteItems = screen.getAllByTestId('note-item');
    expect(noteItems).toHaveLength(2);
    // Most recent note first
    expect(noteItems[0]).toHaveTextContent('Interested in AI');
    expect(noteItems[1]).toHaveTextContent('Met at a conference');
  });

  it('should show empty state when no notes', () => {
    render(
      <AuthenticatedWrapper>
        <ConnectionNotesModal isOpen={true} onClose={mockOnClose} connection={connectionNoNotes} />
      </AuthenticatedWrapper>
    );

    expect(screen.getByTestId('empty-notes-message')).toBeInTheDocument();
  });

  it('should call addNote when add button is clicked', async () => {
    vi.mocked(notesApiService.addNote).mockResolvedValue({ noteId: 'n3' });

    render(
      <AuthenticatedWrapper>
        <ConnectionNotesModal
          isOpen={true}
          onClose={mockOnClose}
          connection={connectionNoNotes}
          onNotesChanged={mockOnNotesChanged}
        />
      </AuthenticatedWrapper>
    );

    const textarea = screen.getByTestId('new-note-input');
    fireEvent.change(textarea, { target: { value: 'New note content' } });

    const addButton = screen.getByTestId('add-note-button');
    fireEvent.click(addButton);

    await waitFor(() => {
      expect(notesApiService.addNote).toHaveBeenCalledWith('c2', 'New note content');
      expect(mockOnNotesChanged).toHaveBeenCalled();
    });
  });

  it('should disable add button when content exceeds 1000 characters', () => {
    render(
      <AuthenticatedWrapper>
        <ConnectionNotesModal isOpen={true} onClose={mockOnClose} connection={connectionNoNotes} />
      </AuthenticatedWrapper>
    );

    const textarea = screen.getByTestId('new-note-input');
    fireEvent.change(textarea, { target: { value: 'A'.repeat(1001) } });

    const addButton = screen.getByTestId('add-note-button');
    expect(addButton).toBeDisabled();
  });

  it('should show character count', () => {
    render(
      <AuthenticatedWrapper>
        <ConnectionNotesModal isOpen={true} onClose={mockOnClose} connection={connectionNoNotes} />
      </AuthenticatedWrapper>
    );

    expect(screen.getByText('0/1000')).toBeInTheDocument();

    const textarea = screen.getByTestId('new-note-input');
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    expect(screen.getByText('5/1000')).toBeInTheDocument();
  });

  it('should enter edit mode when edit button is clicked', () => {
    render(
      <AuthenticatedWrapper>
        <ConnectionNotesModal
          isOpen={true}
          onClose={mockOnClose}
          connection={connectionWithNotes}
        />
      </AuthenticatedWrapper>
    );

    const editButtons = screen.getAllByTestId('edit-note-button');
    fireEvent.click(editButtons[0]);

    expect(screen.getByTestId('edit-note-input')).toBeInTheDocument();
    expect(screen.getByTestId('save-edit-button')).toBeInTheDocument();
  });

  it('should call updateNote when save is clicked in edit mode', async () => {
    vi.mocked(notesApiService.updateNote).mockResolvedValue(undefined);

    render(
      <AuthenticatedWrapper>
        <ConnectionNotesModal
          isOpen={true}
          onClose={mockOnClose}
          connection={connectionWithNotes}
          onNotesChanged={mockOnNotesChanged}
        />
      </AuthenticatedWrapper>
    );

    const editButtons = screen.getAllByTestId('edit-note-button');
    fireEvent.click(editButtons[0]);

    const editInput = screen.getByTestId('edit-note-input');
    fireEvent.change(editInput, { target: { value: 'Updated content' } });

    const saveButton = screen.getByTestId('save-edit-button');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(notesApiService.updateNote).toHaveBeenCalledWith('c1', 'n2', 'Updated content');
      expect(mockOnNotesChanged).toHaveBeenCalled();
    });
  });

  it('should call deleteNote when delete button is clicked', async () => {
    vi.mocked(notesApiService.deleteNote).mockResolvedValue(undefined);

    render(
      <AuthenticatedWrapper>
        <ConnectionNotesModal
          isOpen={true}
          onClose={mockOnClose}
          connection={connectionWithNotes}
          onNotesChanged={mockOnNotesChanged}
        />
      </AuthenticatedWrapper>
    );

    const deleteButtons = screen.getAllByTestId('delete-note-button');
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(notesApiService.deleteNote).toHaveBeenCalledWith('c1', 'n2');
      expect(mockOnNotesChanged).toHaveBeenCalled();
    });
  });

  it('should show "(edited)" indicator when updatedAt differs from timestamp', () => {
    render(
      <AuthenticatedWrapper>
        <ConnectionNotesModal
          isOpen={true}
          onClose={mockOnClose}
          connection={connectionWithNotes}
        />
      </AuthenticatedWrapper>
    );

    // n2 has different updatedAt vs timestamp
    const editedIndicators = screen.getAllByTestId('edited-indicator');
    expect(editedIndicators).toHaveLength(1);
  });

  it('should display AI disclaimer text', () => {
    render(
      <AuthenticatedWrapper>
        <ConnectionNotesModal isOpen={true} onClose={mockOnClose} connection={connectionNoNotes} />
      </AuthenticatedWrapper>
    );

    expect(
      screen.getByText(
        'Notes you add are used to personalize AI-generated messages for this connection.'
      )
    ).toBeInTheDocument();
  });
});
