import { useEffect, useRef, type PointerEvent } from "react";

export type StereoTrace = [number, number][];

const width = 240;
const height = 138;
const radius = height / 2 - 9;

export function StereoScope({ trace, onAdjust, maximum }: {
  trace?: StereoTrace | null;
  onAdjust: (value: number) => void;
  maximum: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    if (!trace?.length) {
      ctx.clearRect(0, 0, width, height);
      return;
    }
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#0005";
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "#aab8f1e0";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const [index, [left, right]] of trace.entries()) {
      const x = width / 2 + (left - right) * radius * 0.5;
      const y = height / 2 - (left + right) * radius * 0.5;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [trace]);

  function adjust(event: PointerEvent<HTMLCanvasElement>) {
    const target = event.currentTarget;
    if (event.type === "pointerdown") {
      if (event.button !== 0 || !event.isPrimary) return;
      target.setPointerCapture(event.pointerId);
    } else if (!target.hasPointerCapture(event.pointerId)) return;
    const { left, width: renderedWidth } = target.getBoundingClientRect();
    onAdjust(Math.round(Math.max(0, Math.min(1, (event.clientX - left) / renderedWidth)) * maximum));
  }

  return <figure className="stereo-spectrogram">
    <figcaption>Output vectorscope</figcaption>
    <div className="vectorscope-plot">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <path d="M120 9 V129 M60 69 H180 M120 9 L180 69 L120 129 L60 69 Z" />
        <path d="M78 27 L162 111 M162 27 L78 111" strokeDasharray="3 3" />
        <text x="77" y="22" textAnchor="middle">R</text>
        <text x="163" y="22" textAnchor="middle">L</text>
      </svg>
      <canvas ref={canvas} width={width} height={height} role="img"
        title="Drag horizontally to adjust the effect amount" onPointerDown={adjust} onPointerMove={adjust}
        aria-label="Live stereo vectorscope. Vertical traces indicate mono and horizontal traces indicate opposite phase." />
    </div>
  </figure>;
}
