import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useLegalAcceptance } from '../hooks/useLegalAcceptance';
import { documentBody, type LegalDocumentId } from '../documents';

/**
 * Blocking acknowledgment of the legal documents.
 *
 * The server already refuses LinkedIn actions until the risk disclosure is
 * accepted (`403 LEGAL_ACCEPTANCE_REQUIRED`), so without this a user has no way
 * to satisfy a gate that is already enforcing. This is the route to acceptance,
 * not the enforcement of it.
 *
 * Deliberately unskippable — no close button, no overlay dismissal. A dialog a
 * user can wave away produces an acceptance record that means nothing, which is
 * worse than not asking.
 */
export const LegalAcceptanceGate: React.FC = () => {
  const {
    isAuthenticated,
    outstanding,
    allAccepted,
    isLoading,
    isError,
    retry,
    isFetching,
    accept,
    isAccepting,
    acceptError,
  } = useLegalAcceptance();
  const [openDocument, setOpenDocument] = useState<LegalDocumentId | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // aria-modal alone neither moves focus into the dialog nor keeps it there, so
  // a keyboard user could tab straight into the page behind a gate that is
  // meant to block. Move focus in on mount and cycle Tab within the dialog.
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;

    const previous = document.activeElement as HTMLElement | null;
    node.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = node.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  });

  // Say nothing until we know: flashing a legal dialog during a page load and
  // then removing it is worse than a moment of nothing.
  if (!isAuthenticated || isLoading) return null;

  // A failed status load must NOT fall through to "nothing outstanding". The
  // server still refuses every LinkedIn action, so hiding the gate here strands
  // the user behind a 403 with no explanation and no way forward.
  if (isError) {
    return (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
        role="alertdialog"
        aria-modal="true"
        data-testid="legal-acceptance-gate"
      >
        <div
          ref={dialogRef}
          tabIndex={-1}
          className="w-full max-w-md space-y-4 rounded-lg bg-background p-6 shadow-xl"
        >
          <h2 className="text-xl font-semibold">We couldn&apos;t load the agreements</h2>
          <p className="text-sm text-muted-foreground">
            Automation stays disabled until these are accepted, so we can&apos;t continue without
            them. Please check your connection and try again.
          </p>
          <button
            onClick={() => retry()}
            disabled={isFetching}
            data-testid="legal-retry-button"
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {isFetching ? 'Retrying…' : 'Try again'}
          </button>
        </div>
      </div>
    );
  }

  if (allAccepted || outstanding.length === 0) return null;

  const firstOutstanding = outstanding[0];
  if (!firstOutstanding) return null;
  const active = openDocument ?? firstOutstanding.documentId;
  const activeDoc = outstanding.find((d) => d.documentId === active) ?? firstOutstanding;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-gate-title"
      data-testid="legal-acceptance-gate"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg bg-background shadow-xl"
      >
        <div className="border-b p-6">
          <h2 id="legal-gate-title" className="text-2xl font-semibold">
            Before you continue
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Please read and accept the following. Automation stays disabled until you do.
          </p>
        </div>

        {outstanding.length > 1 && (
          <div className="flex flex-wrap gap-2 border-b px-6 py-3">
            {outstanding.map((doc) => (
              <button
                key={doc.documentId}
                onClick={() => setOpenDocument(doc.documentId)}
                className={`rounded-md px-3 py-1.5 text-sm ${
                  doc.documentId === active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {doc.title}
              </button>
            ))}
          </div>
        )}

        <div
          className="prose prose-sm dark:prose-invert max-w-none flex-1 overflow-y-auto p-6"
          data-testid="legal-document-body"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{documentBody(active)}</ReactMarkdown>
        </div>

        <div className="space-y-4 border-t p-6">
          {acceptError && (
            <p className="text-sm text-destructive" role="alert">
              We couldn&apos;t record your acceptance. Please try again.
            </p>
          )}

          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4"
              data-testid="legal-confirm-checkbox"
            />
            <span>
              I have read and accept the{' '}
              {outstanding.map((d, i) => (
                <React.Fragment key={d.documentId}>
                  {i > 0 && (i === outstanding.length - 1 ? ' and ' : ', ')}
                  <strong>{d.title}</strong>
                </React.Fragment>
              ))}
              . I understand my LinkedIn account may be restricted or permanently banned as a result
              of using automation, and I accept that risk.
            </span>
          </label>

          <button
            onClick={() => accept(outstanding.map((d) => d.documentId))}
            disabled={!confirmed || isAccepting}
            data-testid="legal-accept-button"
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isAccepting ? 'Recording…' : `Accept and continue`}
          </button>

          <p className="text-center text-xs text-muted-foreground">
            Currently viewing: {activeDoc.title} (version {activeDoc.version})
          </p>
        </div>
      </div>
    </div>
  );
};

export default LegalAcceptanceGate;
