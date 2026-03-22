import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { StickyNote, Pencil, Trash2, Plus } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { notesApiService } from '@/shared/services/notesApiService';
import type { Connection, Note } from '@/shared/types';

interface ConnectionNotesModalProps {
  isOpen: boolean;
  onClose: () => void;
  connection: Connection;
  onNotesChanged?: () => void;
}

const NOTE_MAX_LENGTH = 1000;

function formatNoteDate(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

const ConnectionNotesModal: React.FC<ConnectionNotesModalProps> = ({
  isOpen,
  onClose,
  connection,
  onNotesChanged,
}) => {
  const { toast } = useToast();
  const [localNotes, setLocalNotes] = useState<Note[]>(connection.notes || []);
  const [newNoteContent, setNewNoteContent] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Sync local state when prop changes (e.g., parent refetches)
  useEffect(() => {
    setLocalNotes(connection.notes || []);
  }, [connection.notes]);

  const notes = [...localNotes].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const handleAddNote = async () => {
    if (!newNoteContent.trim() || newNoteContent.length > NOTE_MAX_LENGTH) return;
    setIsSubmitting(true);
    try {
      const trimmedContent = newNoteContent.trim();
      const result = await notesApiService.addNote(connection.id, trimmedContent);
      const now = new Date().toISOString();
      setLocalNotes((prev) => [
        ...prev,
        { id: result.noteId, content: trimmedContent, timestamp: now, updatedAt: now },
      ]);
      setNewNoteContent('');
      onNotesChanged?.();
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to add note. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateNote = async (noteId: string) => {
    if (!editContent.trim() || editContent.length > NOTE_MAX_LENGTH) return;
    setIsSubmitting(true);
    try {
      const trimmedContent = editContent.trim();
      await notesApiService.updateNote(connection.id, noteId, trimmedContent);
      const now = new Date().toISOString();
      setLocalNotes((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, content: trimmedContent, updatedAt: now } : n))
      );
      setEditingNoteId(null);
      setEditContent('');
      onNotesChanged?.();
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to update note. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteNote = async (noteId: string) => {
    setIsSubmitting(true);
    try {
      await notesApiService.deleteNote(connection.id, noteId);
      setLocalNotes((prev) => prev.filter((n) => n.id !== noteId));
      onNotesChanged?.();
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to delete note. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const startEditing = (note: Note) => {
    setEditingNoteId(note.id);
    setEditContent(note.content);
  };

  const cancelEditing = () => {
    setEditingNoteId(null);
    setEditContent('');
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="text-slate-100 bg-slate-900 border border-slate-700 shadow-2xl max-h-[80vh] overflow-y-auto"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle className="text-white flex items-center gap-2">
            <StickyNote className="h-5 w-5" />
            Notes - {connection.first_name} {connection.last_name}
          </DialogTitle>
        </DialogHeader>

        {/* Add note form */}
        <div className="space-y-2">
          <Textarea
            data-testid="new-note-input"
            value={newNoteContent}
            onChange={(e) => setNewNoteContent(e.target.value)}
            placeholder="Add a note about this connection..."
            className="bg-white/5 border-white/20 text-white placeholder-slate-400 min-h-[80px]"
            disabled={isSubmitting}
          />
          <div className="flex items-center justify-between">
            <span
              className={`text-xs ${newNoteContent.length > NOTE_MAX_LENGTH ? 'text-red-400' : 'text-slate-400'}`}
            >
              {newNoteContent.length}/{NOTE_MAX_LENGTH}
            </span>
            <Button
              data-testid="add-note-button"
              onClick={handleAddNote}
              disabled={
                !newNoteContent.trim() || newNoteContent.length > NOTE_MAX_LENGTH || isSubmitting
              }
              size="sm"
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              <Plus className="h-4 w-4 mr-1" />
              Add Note
            </Button>
          </div>
        </div>

        {/* Notes list */}
        <div className="space-y-3 mt-4">
          {notes.length === 0 && (
            <p
              data-testid="empty-notes-message"
              className="text-slate-400 text-sm text-center py-4"
            >
              No notes yet. Add a note to personalize AI-generated messages.
            </p>
          )}
          {notes.map((note) => (
            <div
              key={note.id}
              data-testid="note-item"
              className="bg-white/5 border border-white/10 rounded-lg p-3"
            >
              {editingNoteId === note.id ? (
                <div className="space-y-2">
                  <Textarea
                    data-testid="edit-note-input"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="bg-white/5 border-white/20 text-white min-h-[60px]"
                    disabled={isSubmitting}
                  />
                  <div className="flex items-center justify-between">
                    <span
                      className={`text-xs ${editContent.length > NOTE_MAX_LENGTH ? 'text-red-400' : 'text-slate-400'}`}
                    >
                      {editContent.length}/{NOTE_MAX_LENGTH}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={cancelEditing}
                        className="text-slate-300 hover:text-white"
                      >
                        Cancel
                      </Button>
                      <Button
                        data-testid="save-edit-button"
                        size="sm"
                        onClick={() => handleUpdateNote(note.id)}
                        disabled={
                          !editContent.trim() ||
                          editContent.length > NOTE_MAX_LENGTH ||
                          isSubmitting
                        }
                        className="bg-blue-600 hover:bg-blue-700 text-white"
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-slate-200 text-sm whitespace-pre-wrap">{note.content}</p>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-xs text-slate-400">
                      {formatNoteDate(note.timestamp)}
                      {note.updatedAt !== note.timestamp && (
                        <span data-testid="edited-indicator" className="ml-1 italic">
                          (edited)
                        </span>
                      )}
                    </span>
                    <div className="flex gap-1">
                      <button
                        data-testid="edit-note-button"
                        onClick={() => startEditing(note)}
                        className="text-slate-400 hover:text-blue-300 p-1 transition-colors"
                        title="Edit note"
                        disabled={isSubmitting}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        data-testid="delete-note-button"
                        onClick={() => handleDeleteNote(note.id)}
                        className="text-slate-400 hover:text-red-300 p-1 transition-colors"
                        title="Delete note"
                        disabled={isSubmitting}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        {/* AI disclaimer */}
        <p className="text-xs text-slate-500 mt-4 text-center">
          Notes you add are used to personalize AI-generated messages for this connection.
        </p>
      </DialogContent>
    </Dialog>
  );
};

export default ConnectionNotesModal;
