import { useState, type FormEvent, type ReactNode } from 'react';

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-label={props.title}>
        <header>
          <h2>{props.title}</h2>
          <button className="ghost" onClick={props.onClose} aria-label="Close">✕</button>
        </header>
        {props.children}
      </div>
    </div>
  );
}

/** A modal form whose submit handler may be async; keeps the modal open on error. */
export function FormModal(props: {
  title: string;
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
    <Modal title={props.title} onClose={props.onClose}>
      <form className="form" onSubmit={submit}>
        {props.children}
        {error && <p className="error">{error}</p>}
        <footer>
          <button type="button" className="ghost" onClick={props.onClose}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? 'Working…' : props.submitLabel}</button>
        </footer>
      </form>
    </Modal>
  );
}
