import { useRef } from "react";

export function SidebarDivider({ side, target }: { side: "left" | "right"; target: string }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const direction = side === "left" ? 1 : -1;
  function resize(panel: HTMLElement, width: number) {
    const max = side === "left" ? Math.min(260, innerWidth * 0.24) : Math.max(200, innerWidth * 0.76 - 330);
    const next = Math.round(Math.min(max, Math.max(side === "left" ? 75 : 200, width)));
    panel.style.flexBasis = `${next}px`;
  }
  return <div className="sidebar-divider" role="separator" aria-orientation="vertical" aria-controls={target}
    aria-label={`Resize ${side === "left" ? "mixer" : "effects"} sidebar`} tabIndex={0}
    onPointerDown={(event) => {
      const panel = document.getElementById(target);
      if (!panel || event.button !== 0 || !event.isPrimary) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, width: panel.getBoundingClientRect().width };
    }}
    onPointerMove={(event) => {
      const panel = document.getElementById(target);
      if (panel && drag.current) resize(panel, drag.current.width + (event.clientX - drag.current.x) * direction);
    }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={(event) => {
      const panel = document.getElementById(target);
      if (!panel || !["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Home") panel.style.removeProperty("flex-basis");
      else resize(panel, panel.getBoundingClientRect().width + (event.key === "ArrowRight" ? 12 : -12) * direction);
    }}
    onDoubleClick={() => document.getElementById(target)?.style.removeProperty("flex-basis")} />;
}
