import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

export function Modal(props: { title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null);
  // Keyboard users land inside the dialog, and go back where they were when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    if (!dialog.current?.contains(document.activeElement)) dialog.current?.focus();
    return () => before?.focus?.();
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div ref={dialog} tabIndex={-1} className={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title}>
        <header className="modal-head">
          <div>
            <h2>{props.title}</h2>
            {props.subtitle && <div className="modal-subtitle">{props.subtitle}</div>}
          </div>
          <button className="icon-btn close" onClick={props.onClose} aria-label="Close" title="Close (Esc)">✕</button>
        </header>
        {props.children}
      </div>
    </div>
  );
}

/** A modal form whose submit handler may be async; keeps the modal open on error. */
export function FormModal(props: {
  title: string;
  subtitle?: ReactNode;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (data: FormData) => Promise<unknown>;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit(new FormData(e.currentTarget));
      props.onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={props.title} subtitle={props.subtitle} onClose={props.onClose}>
      <form className="form" onSubmit={submit}>
        {props.children}
        {error && <p className="error">{error}</p>}
        <footer className="form-actions">
          <button type="button" className="ghost" onClick={props.onClose}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? 'Working…' : props.submitLabel}</button>
        </footer>
      </form>
    </Modal>
  );
}
