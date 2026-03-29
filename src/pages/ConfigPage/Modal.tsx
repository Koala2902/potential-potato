import { useEffect } from "react";
import { createPortal } from "react-dom";

type ModalProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Wider dialog for dense tables */
  wide?: boolean;
};

export function Modal({ open, title, onClose, children, footer, wide }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="config-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className={"config-modal" + (wide ? " config-modal--wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-labelledby="config-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="config-modal__header">
          <h2 id="config-modal-title" className="config-modal__title">
            {title}
          </h2>
          <button type="button" className="config-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="config-modal__body">{children}</div>
        {footer ? <footer className="config-modal__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body
  );
}
