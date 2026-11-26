import * as Select from "@radix-ui/react-select";
import * as Menu from "@radix-ui/react-context-menu";
import { Check, ChevronDown, X } from "lucide-react";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";

const ModalContainer = createContext<HTMLElement | null>(null);

export function ContextActions({ children, items }: { children: ReactElement;
  items: { label: string; action: () => void; disabled?: boolean }[] }) {
  const container = useContext(ModalContainer);
  return <Menu.Root>
    <Menu.Trigger asChild>{children}</Menu.Trigger>
    <Menu.Portal container={container ?? undefined}>
      <Menu.Content className="dropdown-menu context-menu" collisionPadding={8}>
        {items.map(({ label, action, disabled }) => <Menu.Item key={label} className="dropdown-item"
          disabled={disabled} onSelect={action}>{label}</Menu.Item>)}
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>;
}

export function Dropdown({ label, placeholder = label, value, options, change, disabled, icon }: {
  label: string; placeholder?: string; value: string; options: { value: string; label: string; icon?: ReactNode }[];
  change: (value: string) => void; disabled?: boolean;
  icon?: ReactNode;
}) {
  const container = useContext(ModalContainer);
  return <Select.Root value={value} onValueChange={change} disabled={disabled || options.length === 0}>
    <Select.Trigger className="dropdown" aria-label={label}>
      {options.find((option) => option.value === value)?.icon ?? icon}
      <span className="dropdown-value" title={options.find((option) => option.value === value)?.label}>
        <Select.Value placeholder={placeholder} />
      </span>
      <Select.Icon asChild><ChevronDown size={13} aria-hidden="true" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal container={container ?? undefined}>
      <Select.Content className="dropdown-menu" position="popper" sideOffset={5} collisionPadding={10}>
        <Select.Viewport>
          {options.map((option) => <Select.Item className="dropdown-item" key={option.value} value={option.value}>
            <span className="dropdown-label">{option.icon}<Select.ItemText>{option.label}</Select.ItemText></span>
            <Select.ItemIndicator><Check size={14} aria-hidden="true" /></Select.ItemIndicator>
          </Select.Item>)}
        </Select.Viewport>
      </Select.Content>
    </Select.Portal>
  </Select.Root>;
}

export function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const [element, setElement] = useState<HTMLDialogElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    if (!element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    return () => {
      element.close();
      previous?.focus();
    };
  }, [element]);
  return <dialog ref={setElement} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); close(); }}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="dialog-body">
      <div className="dialog-head"><h2 id={titleId}>{title}</h2>
        <button className="quiet" type="button" aria-label="Close dialog" onClick={close}><X aria-hidden="true" /></button></div>
      <ModalContainer.Provider value={element}>{children}</ModalContainer.Provider>
    </div>
  </dialog>;
}

export function Knob({ label, shortLabel = label, value, min, max, step, change, format, logarithmic = false, reset = min }: {
  label: string; shortLabel?: string; value: number; min: number; max: number; step: number;
  format: (value: number) => string; change: (value: number) => void; logarithmic?: boolean; reset?: number;
}) {
  const drag = useRef<{ pointer: number; y: number; fraction: number } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const fraction = logarithmic ? Math.log(value / min) / Math.log(max / min) : (value - min) / (max - min);
  const set = (next: number) => {
    const bounded = Math.min(1, Math.max(0, next));
    const raw = logarithmic ? min * (max / min) ** bounded : min + bounded * (max - min);
    change(Math.min(max, Math.max(min, Number((Math.round(raw / step) * step).toFixed(6)))));
  };
  return <ContextActions items={[
    { label: `Edit ${label}`, action: () => setDraft(String(value)) },
    { label: `Reset ${label}`, action: () => change(reset) },
  ]}><div className="knob-control">
    <div className="knob" role="slider" tabIndex={0} aria-label={label} aria-valuemin={min}
      aria-valuemax={max} aria-valuenow={value} aria-valuetext={format(value)}
      onKeyDown={(event) => {
        const increment = logarithmic ? 0.01 : step / (max - min);
        const delta = { ArrowUp: increment, ArrowRight: increment, ArrowDown: -increment, ArrowLeft: -increment,
          PageUp: 0.1, PageDown: -0.1 }[event.key];
        if (delta !== undefined) { event.preventDefault(); set(fraction + delta); }
        if (event.key === "Home" || event.key === "End") { event.preventDefault(); set(event.key === "Home" ? 0 : 1); }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, y: event.clientY, fraction };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start?.pointer === event.pointerId) set(start.fraction + (start.y - event.clientY) / 150);
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onDoubleClick={() => change(reset)}>
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path className="knob-track" d="M 11 37 A 18.4 18.4 0 1 1 37 37" pathLength="100" />
        <path className="knob-fill" d="M 11 37 A 18.4 18.4 0 1 1 37 37" pathLength="100"
          strokeDasharray={`${fraction * 100} 100`} />
        <circle cx="24" cy="24" r="13" />
        <path className="knob-tick" d="M 24 14 V 19" transform={`rotate(${-135 + fraction * 270} 24 24)`} />
      </svg>
    </div>
    <span title={label}>{shortLabel}</span>
    {draft === null ? <button className="knob-value" type="button" aria-label={`Edit ${label} value`}
      onClick={() => setDraft(String(value))}>{format(value)}</button>
      : <input className="knob-value" aria-label={`${label} value`} type="number" min={min} max={max} step={step}
        value={draft} autoFocus onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") { event.stopPropagation(); setDraft(null); }
        }}
        onBlur={() => {
          if (draft.trim() && Number.isFinite(Number(draft))) change(Math.min(max, Math.max(min, Number(draft))));
          setDraft(null);
        }} />}
  </div></ContextActions>;
}
