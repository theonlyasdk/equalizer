import { ArrowDown, ArrowUp, AudioLines, AudioWaveform, ChartNoAxesColumn, ChevronDown, GripVertical, Maximize2, Minimize2, MoveHorizontal, Plus, Power, Trash2, Volume2, Waves, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { ContextActions, Dropdown, Knob } from "./controls";
import { StereoSpectrogram, type StereoBands } from "./stereo-spectrum";
import { StereoScope, type StereoTrace } from "./stereo-scope";

export const effectSpecs = {
  gain: { name: "Gain", label: "Level", min: -24, max: 12, initial: 0, step: 0.5 },
  compressor: { name: "Compressor", label: "Threshold", min: -48, max: 0, initial: -18, step: 0.5 },
  saturation: { name: "Saturation", label: "Drive", min: 0, max: 24, initial: 3, step: 0.5 },
  stereoWidth: { name: "Stereo width", label: "Width", min: 0, max: 200, initial: 100, step: 1 },
  spatialExpander: { name: "Spatial expander", label: "Expansion", min: 0, max: 100, initial: 45, step: 1 },
  spectrogram: { name: "Spectrogram", label: "", min: 0, max: 0, initial: 0, step: 1 },
  tremolo: { name: "Tremolo", label: "Rate", min: 0.1, max: 20, initial: 4, step: 0.1 },
  lowCut: { name: "Low cut", label: "Cutoff", min: 20, max: 20000, initial: 80, step: 1 },
  highCut: { name: "High cut", label: "Cutoff", min: 20, max: 20000, initial: 12000, step: 1 },
};
type Kind = keyof typeof effectSpecs;
const effectIcons = { gain: Volume2, compressor: AudioLines, saturation: AudioWaveform, stereoWidth: MoveHorizontal,
  spatialExpander: Maximize2, spectrogram: ChartNoAxesColumn, tremolo: Waves };
type Compression = { ratio: number; attack: number; release: number; knee: number; makeup: number; mix: number; rms: boolean; auto_makeup: boolean };
type Saturation = { mode: "soft" | "tube" | "hard"; mix: number };
type Spatial = { bass_hz: number; ambience: number };
const spatialDefaults: Spatial = { bass_hz: 150, ambience: 25 };
export type Effect = { id: number; kind: Kind; amount: number; enabled: boolean;
  compressor?: Compression; saturation?: Saturation; spatial?: Spatial };
export type Reductions = [number, number][];

const defaults: Compression = { ratio: 4, attack: 4, release: 104, knee: 0, makeup: 0, mix: 100, rms: false, auto_makeup: true };
const decibels = (value: number) => `${value.toFixed(1)} dB`;
const millis = (value: number) => `${value} ms`;
const point = (value: number) => Math.min(0, Math.max(-60, value));

function compressionPath(effect: Effect, config = { ...defaults, ...effect.compressor }) {
  const auto = config.auto_makeup ? Math.min(12, -effect.amount * (1 - 1 / config.ratio) / 2) : 0;
  return Array.from({ length: 61 }, (_, i) => {
    const input = i - 60;
    const over = input - effect.amount;
    const half = config.knee / 2;
    const compressed = half > 0 && Math.abs(over) < half ? ((over + half) ** 2) / (4 * half) : Math.max(0, over);
    const wet = 10 ** ((auto + config.makeup - compressed * (1 - 1 / config.ratio)) / 20);
    const output = input + 20 * Math.log10(1 + (wet - 1) * config.mix / 100);
    return `${i ? "L" : "M"}${i * 3},${-point(output) * 1.5}`;
  }).join(" ");
}

function editPlot(event: PointerEvent<SVGSVGElement>, edit: (x: number, y: number) => void) {
  const plot = event.currentTarget;
  if (event.type === "pointerdown") {
    if (event.button !== 0 || !event.isPrimary) return;
    plot.setPointerCapture(event.pointerId);
  } else if (!plot.hasPointerCapture(event.pointerId)) return;
  const rect = plot.getBoundingClientRect();
  const fraction = (value: number) => Math.max(0, Math.min(1, value));
  edit(fraction((event.clientX - rect.left) / rect.width), fraction((event.clientY - rect.top) / rect.height));
}

function EffectPreview({ effect, change }: { effect: Effect; change: (patch: Partial<Effect>) => void }) {
  const cutoff = effect.kind === "lowCut" || effect.kind === "highCut";
  const saturation = effect.saturation ?? { mode: "soft", mix: 100 };
  const path = effect.kind === "compressor" ? compressionPath(effect) : Array.from({ length: 61 }, (_, i) => {
    const x = i / 60;
    let y;
    if (cutoff) {
      const hz = 20 * 1000 ** x;
      const ratio = effect.kind === "lowCut" ? effect.amount / hz : hz / effect.amount;
      y = Math.min(90, 10 - 15 * Math.log10(1 / (1 + ratio ** 4)));
    } else if (effect.kind === "saturation") {
      const dry = 2 * x - 1;
      const driven = dry * 10 ** (effect.amount / 20);
      const wet = saturation.mode === "tube" ? Math.tanh(driven) : saturation.mode === "hard"
        ? Math.max(-1, Math.min(1, driven)) : driven / Math.sqrt(1 + driven * driven);
      y = 45 * (1 - dry - (wet - dry) * saturation.mix / 100);
    } else if (effect.kind === "tremolo") {
      y = 62 - 32 * Math.cos(2 * Math.PI * x * effect.amount / 4);
    } else {
      y = -point(i - 60 + effect.amount) * 1.5;
    }
    return `${i ? "L" : "M"}${i * 3},${y.toFixed(2)}`;
  }).join(" ");
  const edit = (event: PointerEvent<SVGSVGElement>) => editPlot(event, (x, y) => {
    const amount = cutoff ? Math.round(20 * 1000 ** x)
      : effect.kind === "compressor" ? Math.round(Math.max(-48, x * 60 - 60) * 2) / 2
      : effect.kind === "saturation" ? Math.round((1 - y) * 48) / 2
      : effect.kind === "tremolo" ? Math.max(0.1, Math.round(x * 200) / 10)
      : Math.round((12 - y * 36) * 2) / 2;
    change({ amount });
  });
  return <svg className="effect-preview" viewBox="0 0 180 90" preserveAspectRatio="none" role="img"
    onPointerDown={edit} onPointerMove={edit}
    aria-label={`${effectSpecs[effect.kind].name} preview`}>
    <path className="transfer-grid" d="M0 30 H180 M0 60 H180 M60 0 V90 M120 0 V90" />
    <path className="transfer-reference" d={cutoff ? "M0 10 H180" : "M0 90 L180 0"} />
    <path className="transfer-curve" d={path} />
  </svg>;
}

function CompressorEditor({ effect, change, reductions }: {
  effect: Effect; change: (patch: Partial<Effect>) => void; reductions: Reductions;
}) {
  const config = { ...defaults, ...effect.compressor };
  const [view, setView] = useState<"curve" | "history">("curve");
  const [history, setHistory] = useState<number[]>([]);
  const reduction = reductions.find(([id]) => id === effect.id)?.[1] ?? 0;
  const plotId = useId();
  const transfer = compressionPath(effect, config);
  const slope = 1 - 1 / config.ratio;
  const half = config.knee / 2;
  const compressed = reduction / Math.max(0.001, slope);
  const over = half > 0 && compressed < half ? Math.sqrt(4 * half * compressed) - half : compressed;
  const input = Math.round(point(reduction > 0 ? effect.amount + over : -60));
  const dotX = (input + 60) * 3;
  const dotY = Number(transfer.split(" ")[input + 60]?.split(",")[1] ?? 90);
  useEffect(() => {
    setHistory((previous) => [...previous.slice(-95), reduction]);
  }, [reductions, reduction]);
  const adjust = (patch: Partial<Compression>) => change({ compressor: { ...config, ...patch } });
  const timeline = history.map((value, index) =>
    `${index ? "L" : "M"}${(96 - history.length + index) * 180 / 95},${Math.min(90, value * 3)}`).join(" ");
  return <div className="compressor-editor">
    <div className="compressor-toolbar">
      <button aria-pressed={view === "curve"} onClick={() => setView("curve")}>Curve</button>
      <button aria-pressed={view === "history"} onClick={() => setView("history")}>History</button>
    </div>
    <svg className="compressor-display" viewBox="0 0 180 90" preserveAspectRatio="none" role="img"
      onPointerDown={(event) => editPlot(event, (x) => change({ amount: Math.round(Math.max(-48, x * 60 - 60) * 2) / 2 }))}
      onPointerMove={(event) => editPlot(event, (x) => change({ amount: Math.round(Math.max(-48, x * 60 - 60) * 2) / 2 }))}
      aria-label={view === "curve" ? "Compressor transfer curve" : "Gain reduction history"}>
      <path className="transfer-grid" d="M0 22.5 H180 M0 45 H180 M0 67.5 H180 M45 0 V90 M90 0 V90 M135 0 V90" />
      {view === "curve" && <path className="transfer-reference" d="M0 90 L180 0" />}
      {view === "curve" && <>
        <defs><linearGradient id={`${plotId}-fill`} x2="0%" y2="100%">
          <stop stopColor="#e5b48e" stopOpacity=".65" /><stop offset="1" stopColor="#e5b48e" stopOpacity="0" />
        </linearGradient><clipPath id={`${plotId}-clip`}><rect width={dotX} height="90" /></clipPath></defs>
        <path d={`${transfer} L180,90 H0Z`} style={{ fill: `url(#${plotId}-fill)` }} clipPath={`url(#${plotId}-clip)`} />
      </>}
      <path className="transfer-curve" d={view === "curve" ? transfer : timeline} />
      {view === "curve" && <circle cx={dotX} cy={dotY} r="3" fill="#ffd1aa" />}
    </svg>
    <div className="compressor-knobs">
      <Knob label="Ratio" value={config.ratio} min={1} max={20} step={0.1} reset={4} logarithmic format={(value) => `${value}:1`} change={(ratio) => adjust({ ratio })} />
      <Knob label="Attack" value={config.attack} min={0.1} max={100} step={0.1} reset={4} logarithmic format={millis} change={(attack) => adjust({ attack })} />
      <Knob label="Release" value={config.release} min={10} max={1000} step={1} reset={104} logarithmic format={millis} change={(release) => adjust({ release })} />
      <Knob label="Knee" value={config.knee} min={0} max={24} step={0.5} reset={0} format={decibels} change={(knee) => adjust({ knee })} />
      <Knob label="Makeup gain" value={config.makeup} min={-12} max={24} step={0.5} reset={0} format={decibels} change={(makeup) => adjust({ makeup })} />
      <Knob label="Dry/Wet" value={config.mix} min={0} max={100} step={1} reset={100} format={(value) => `${value}%`} change={(mix) => adjust({ mix })} />
    </div>
  </div>;
}

export function EffectRack({ effects, add, change, move, remove, reductions, stereo, trace }: {
  effects: Effect[]; add: (kind: Kind) => void; change: (id: number, patch: Partial<Effect>) => void;
  move: (index: number, direction: number) => void; remove: (id: number) => void; reductions: Reductions;
  stereo?: StereoBands | null;
  trace?: StereoTrace | null;
}) {
  const [collapsed, setCollapsed] = useState<number[]>([]);
  const [enlarged, setEnlarged] = useState<{ kind: "vectorscope"; effectId: number; max: number } | { kind: "spectrogram"; effectId: number } | null>(null);
  useEffect(() => {
    if (!enlarged) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEnlarged(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enlarged]);
  const chain = useRef<HTMLDivElement>(null);
  const before = useRef<Map<string, number> | null>(null);
  const liftedId = useRef<string | undefined>();
  const scrollFrame = useRef(0);
  const drag = useRef<{ rows: HTMLElement[]; tops: number[]; from: number; to: number; start: number; scroll: number } | null>(null);
  const pointerY = useRef(0);
  function updateDrag(clientY: number) {
    const active = drag.current;
    if (!active || !chain.current) return;
    const delta = clientY - active.start + chain.current.scrollTop - active.scroll;
    const lifted = active.rows[active.from];
    lifted.style.transform = `translateY(${delta}px) scale(1.02)`;
    const center = active.tops[active.from] + lifted.offsetHeight / 2 + delta;
    active.to = active.from;
    active.rows.forEach((row, position) => {
      if (position === active.from) return;
      const midpoint = active.tops[position] + row.offsetHeight / 2;
      const crossedDown = position > active.from && center >= midpoint;
      const crossedUp = position < active.from && center <= midpoint;
      if (crossedDown) active.to = Math.max(active.to, position);
      if (crossedUp) active.to = Math.min(active.to, position);
      row.dataset.shifting = "true";
      row.style.transform = `translateY(${crossedDown ? -lifted.offsetHeight : crossedUp ? lifted.offsetHeight : 0}px)`;
    });
  }
  function autoScroll() {
    const element = chain.current;
    if (!element || !drag.current) return;
    const rect = element.getBoundingClientRect();
    const zone = 44;
    const top = Math.max(0, Math.min(1, (rect.top + zone - pointerY.current) / zone));
    const bottom = Math.max(0, Math.min(1, (pointerY.current - rect.bottom + zone) / zone));
    const previous = element.scrollTop;
    element.scrollTop += (bottom - top) * 13;
    if (previous !== element.scrollTop) updateDrag(pointerY.current);
    scrollFrame.current = requestAnimationFrame(autoScroll);
  }
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);
  function finishDrag(commit: boolean) {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    cancelAnimationFrame(scrollFrame.current);
    const lifted = active.rows[active.from];
    const transform = lifted.style.transform || "scale(1.02)";
    if (commit && active.from !== active.to && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      before.current = new Map(active.rows.map((row) => [row.dataset.effect!, row.getBoundingClientRect().top]));
      liftedId.current = lifted.dataset.effect;
    }
    active.rows.forEach((row) => { row.style.removeProperty("transform"); delete row.dataset.lifted; delete row.dataset.shifting; });
    if (commit && active.from !== active.to) move(active.from, active.to - active.from);
    else if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      lifted.animate([{ transform, boxShadow: "0 10px 24px #000b" }, { transform: "none", boxShadow: "none" }],
        { duration: 180, easing: "cubic-bezier(.23, 1, .32, 1)" });
    }
  }
  const order = effects.map(({ id }) => id).join(",");
  useLayoutEffect(() => {
    const previous = before.current;
    before.current = null;
    if (!previous) return;
    chain.current?.querySelectorAll<HTMLElement>("[data-effect]").forEach((element) => {
      const top = previous.get(element.dataset.effect!);
      if (top === undefined) return;
      element.getAnimations().forEach((animation) => animation.cancel());
      const offset = top - element.getBoundingClientRect().top;
      const lifted = element.dataset.effect === liftedId.current;
      if (offset || lifted) element.animate([{ transform: `translateY(${offset}px) scale(${lifted ? 1.02 : 1})` },
        { transform: "translateY(0) scale(1)" }],
        { duration: 180, easing: "cubic-bezier(0.77, 0, 0.175, 1)" });
    });
    liftedId.current = undefined;
  }, [order]);
  const reorder = (index: number, direction: number, pointer: boolean) => {
    if (pointer && !matchMedia("(prefers-reduced-motion: reduce)").matches && chain.current) {
      before.current = new Map(Array.from(chain.current.querySelectorAll<HTMLElement>("[data-effect]"),
        (element) => [element.dataset.effect!, element.getBoundingClientRect().top]));
    }
    move(index, direction);
  };
  return <aside id="effects-rack" className="rack" aria-labelledby="rack-title">
    <div className="rack-header">
      <h2 id="rack-title">Effects</h2>
      <Dropdown label="Add effect" placeholder="Add" icon={<Plus aria-hidden="true" />} value="" disabled={effects.length >= 12}
        options={Object.entries(effectSpecs).filter(([kind]) => kind !== "lowCut" && kind !== "highCut")
          .map(([value, spec]) => {
            const Icon = effectIcons[value as keyof typeof effectIcons];
            return { value, label: spec.name, icon: Icon && <Icon aria-hidden="true" /> };
          })}
        change={(value) => add(value as Kind)} />
    </div>
    <div className="rack-chain" ref={chain}>
      {effects.length === 0 && <p className="rack-empty">Add an effect to start the chain.</p>}
      {effects.map((effect, index) => {
        const spec = effectSpecs[effect.kind];
        const isCompressor = effect.kind === "compressor";
        const isExpanded = isCompressor && !collapsed.includes(effect.id);
        const hidden = collapsed.includes(effect.id);
        const toggle = () => setCollapsed((previous) => hidden ? previous.filter((id) => id !== effect.id) : [...previous, effect.id]);
        const cutoff = effect.kind === "lowCut" || effect.kind === "highCut";
        const spatial = effect.kind === "spatialExpander";
        const stereoEffect = spatial || effect.kind === "stereoWidth";
        const isSpectrogram = effect.kind === "spectrogram";
        const spatialSettings = { ...spatialDefaults, ...effect.spatial };
        const reduction = reductions.find(([id]) => id === effect.id)?.[1] ?? 0;
        const config = { ...defaults, ...effect.compressor };
        return <ContextActions key={effect.id} items={[
          { label: effect.enabled ? "Bypass effect" : "Enable effect", icon: <Power aria-hidden="true" />, action: () => change(effect.id, { enabled: !effect.enabled }) },
          { label: hidden ? "Expand effect" : "Collapse effect", icon: hidden ? <Maximize2 aria-hidden="true" /> : <Minimize2 aria-hidden="true" />, action: toggle },
          { label: "Move up", icon: <ArrowUp aria-hidden="true" />, action: () => move(index, -1), disabled: index === 0 },
          { label: "Move down", icon: <ArrowDown aria-hidden="true" />, action: () => move(index, 1), disabled: index === effects.length - 1 },
          { label: "Remove effect", icon: <Trash2 aria-hidden="true" />, action: () => remove(effect.id) },
        ]}><section className={`rack-module ${effect.kind}`} data-effect={effect.id} aria-label={`${spec.name} effect ${index + 1}`}>
          <div className="module-top" onDoubleClick={(event) => {
            if (!(event.target as Element).closest("button")) toggle();
          }}>
            <button type="button" className="effect-grip rack-action" aria-label={`Drag ${spec.name} to reorder`}
              title="Drag to reorder" tabIndex={-1} onPointerDown={(event) => {
                if (event.button !== 0 || !event.isPrimary || !chain.current) return;
                const rows = Array.from(chain.current.querySelectorAll<HTMLElement>("[data-effect]"));
                rows.forEach((row) => row.getAnimations().forEach((animation) => animation.cancel()));
                drag.current = { rows, tops: rows.map((row) => row.getBoundingClientRect().top), from: index, to: index,
                  start: event.clientY, scroll: chain.current.scrollTop };
                event.currentTarget.setPointerCapture(event.pointerId);
                rows[index].dataset.lifted = "true";
                pointerY.current = event.clientY;
                scrollFrame.current = requestAnimationFrame(autoScroll);
              }} onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                pointerY.current = event.clientY;
                updateDrag(event.clientY);
              }} onPointerUp={() => finishDrag(true)} onLostPointerCapture={() => finishDrag(false)}>
              <GripVertical aria-hidden="true" />
            </button>
            <button type="button" className="module-power" aria-label={`Enable ${spec.name}`} aria-pressed={effect.enabled}
              onClick={() => change(effect.id, { enabled: !effect.enabled })}><Power aria-hidden="true" /></button>
            <h3>{spec.name}</h3>
            {isCompressor && <button type="button" className="rack-action compressor-toggle" aria-label="Compressor controls"
              title={isExpanded ? "Collapse compressor controls" : "Expand compressor controls"} aria-expanded={isExpanded}
              onClick={toggle}>
              <ChevronDown aria-hidden="true" /></button>}
            <button type="button" className="rack-action" aria-label={`Move ${spec.name} up`} disabled={index === 0}
              onClick={(event) => reorder(index, -1, event.detail > 0)}><ArrowUp aria-hidden="true" /></button>
            <button type="button" className="rack-action" aria-label={`Move ${spec.name} down`} disabled={index === effects.length - 1}
              onClick={(event) => reorder(index, 1, event.detail > 0)}><ArrowDown aria-hidden="true" /></button>
            <button type="button" className="rack-action" aria-label={`Remove ${spec.name}`} onClick={() => remove(effect.id)}><X aria-hidden="true" /></button>
          </div>
          {!hidden && isSpectrogram && <div className="stereo-effect" data-bypassed={!effect.enabled}>
            <StereoSpectrogram bands={effect.enabled ? stereo : null} onDoubleClick={() => setEnlarged({ kind: "spectrogram", effectId: effect.id })} />
          </div>}
          {!hidden && stereoEffect && <div className="stereo-effect" data-bypassed={!effect.enabled}>
            <StereoScope trace={trace} maximum={spec.max} onAdjust={(amount) => change(effect.id, { amount })}
              onDoubleClick={() => setEnlarged({ kind: "vectorscope", effectId: effect.id, max: spec.max })} />
            <div className="stereo-controls">
              <Knob label={spec.label} value={effect.amount} min={spec.min} max={spec.max} step={spec.step}
                reset={spec.initial} format={(value) => `${value}%`} change={(amount) => change(effect.id, { amount })} />
              {spatial && <>
                <Knob label="Bass focus" value={spatialSettings.bass_hz} min={60} max={400} step={1}
                  reset={spatialDefaults.bass_hz} logarithmic format={(value) => `${value} Hz`}
                  change={(bass_hz) => change(effect.id, { spatial: { ...spatialSettings, bass_hz } })} />
                <Knob label="Ambience" value={spatialSettings.ambience} min={0} max={100} step={1}
                  reset={spatialDefaults.ambience} format={(value) => `${value}%`}
                  change={(ambience) => change(effect.id, { spatial: { ...spatialSettings, ambience } })} />
              </>}
            </div>
          </div>}
          {!hidden && !stereoEffect && !isSpectrogram && <div className="module-controls" data-bypassed={!effect.enabled}>
            {effect.kind !== "saturation" && <Knob label={spec.label} value={effect.amount} min={spec.min} max={spec.max} step={spec.step}
              reset={spec.initial} logarithmic={cutoff} format={
                cutoff || effect.kind === "tremolo" ? (value) => `${value} Hz` : decibels}
              change={(amount) => change(effect.id, { amount })} />}
            {isExpanded ? <div className="compression-meter">
              <span>GR {decibels(reduction ? -reduction : 0)}</span>
              <div className="gr-track" role="meter" aria-label="Gain reduction in decibels"
                aria-valuemin={0} aria-valuemax={24} aria-valuenow={Math.min(24, reduction)}>
                <div className="gr-fill" style={{ clipPath: `inset(0 ${100 - Math.min(24, reduction) / 24 * 100}% 0 0)` }} />
              </div>
              <div className="compressor-toolbar">
                <Dropdown label="Detector" value={config.rms ? "rms" : "peak"}
                  options={[{ value: "peak", label: "Peak" }, { value: "rms", label: "RMS" }]}
                  change={(value) => change(effect.id, { compressor: { ...config, rms: value === "rms" } })} />
                <button aria-pressed={config.auto_makeup}
                  onClick={() => change(effect.id, { compressor: { ...config, auto_makeup: !config.auto_makeup } })}>Auto makeup</button>
              </div>
            </div> : <EffectPreview effect={effect} change={(patch) => change(effect.id, patch)} />}
          </div>}
          {isExpanded && <CompressorEditor effect={effect} reductions={reductions} change={(patch) => change(effect.id, patch)} />}
          {!hidden && effect.kind === "saturation" && <div className="saturation-options">
            <Knob label="Drive" value={effect.amount} min={spec.min} max={spec.max} step={spec.step}
              reset={spec.initial} format={decibels} change={(amount) => change(effect.id, { amount })} />
            <Knob label="Dry/Wet" value={effect.saturation?.mix ?? 100} min={0} max={100} step={1} reset={100}
              format={(value) => `${value}%`} change={(mix) => change(effect.id, { saturation: { mode: effect.saturation?.mode ?? "soft", mix } })} />
            <Dropdown label="Saturation mode" value={effect.saturation?.mode ?? "soft"}
              options={[{ value: "soft", label: "Soft clip" }, { value: "tube", label: "Tube" }, { value: "hard", label: "Hard clip" }]}
              change={(mode) => change(effect.id, { saturation: { mode: mode as Saturation["mode"], mix: effect.saturation?.mix ?? 100 } })} />
          </div>}
        </section></ContextActions>;
      })}
    </div>
    {enlarged && (() => {
      const targetEffect = effects.find((item) => item.id === enlarged.effectId);
      if (!targetEffect) return null;
      return createPortal(
        <div className="analyzer-spotlight" onClick={(event) => { if (event.target === event.currentTarget) setEnlarged(null); }}>
          <div className="analyzer-spotlight-panel" data-bypassed={!targetEffect.enabled}>
            {enlarged.kind === "vectorscope" ? (
              <StereoScope trace={trace} maximum={enlarged.max}
                onAdjust={(amount) => change(targetEffect.id, { amount })}
                onDoubleClick={() => setEnlarged(null)} />
            ) : (
              <StereoSpectrogram bands={targetEffect.enabled ? stereo : null}
                onDoubleClick={() => setEnlarged(null)} />
            )}
          </div>
        </div>,
        document.body,
      );
    })()}
  </aside>;
}
