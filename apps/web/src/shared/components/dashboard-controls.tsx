import { Check, ChevronDown, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

export function WizardSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<readonly [string, string, string?]>;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find(([optionValue]) => optionValue === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div className="wizard-select" ref={root}>
      <button
        type="button"
        className="wizard-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.[1] ?? "Select an option"}</span>
        <ChevronDown size={17} />
      </button>
      {open && (
        <div className="wizard-select-menu" role="listbox">
          {options.map(([optionValue, label, description]) => (
            <button
              type="button"
              role="option"
              aria-selected={optionValue === value}
              className={optionValue === value ? "selected" : ""}
              key={optionValue || "empty"}
              onClick={() => {
                onChange(optionValue);
                setOpen(false);
              }}
            >
              <span>
                <strong>{label}</strong>
                {description && <small>{description}</small>}
              </span>
              {optionValue === value && <Check size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
