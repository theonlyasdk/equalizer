import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { createRoot } from "react-dom/client";
import { Activity, AudioLines, ChartNoAxesColumn, Download, Headphones, Layers, Minimize2, MonitorCog, Palette, Plus, Power,
  RefreshCw, RotateCcw, Save, Settings2, SlidersHorizontal, Trash2, X } from "lucide-react";
import { ContextActions, Dropdown, Knob, Modal } from "./controls";
import { EffectRack, effectSpecs, type Effect, type Reductions } from "./effects";
import type { StereoBands } from "./stereo-spectrum";
import type { StereoTrace } from "./stereo-scope";
import { SidebarDivider } from "./sidebar";
import "./style.css";

const shapes = {
  bell: "Bell", lowShelf: "Low shelf", highShelf: "High shelf",
  lowCut: "Low cut", highCut: "High cut", notch: "Notch",
};
type Shape = keyof typeof shapes;
type Band = { id: number; shape: Shape; hz: number; gain: number; q: number; enabled: boolean };
type Tone = { bass_hz: number; bass_q: number; treble_hz: number; treble_q: number };
const defaultTone: Tone = { bass_hz: 110, bass_q: 0.707, treble_hz: 4500, treble_q: 0.707 };
type Settings = { tone: Tone; bands: Band[]; bass: number; treble: number; gain: number; pre_gain: number; pan: number; effects: Effect[]; bypass: boolean; disable_bass_protection?: boolean };
type Library = {
  input: string; output: string; settings: Settings;
  presets: Record<string, Settings>; device_presets: Record<string, string>;
  suspended?: boolean;
  quit_on_close?: boolean;
};
type Device = { id: string; name: string };
type Meter = { status: string; peak: [number, number]; spectrum: number[]; bass: number; compression?: Reductions;
  stereo?: StereoBands | null; scope?: StereoTrace | null };
const builtinPresetNames = new Set([
  "Acoustic & Jazz",
  "Bass Boost",
  "Electronic & Pop",
  "Flat",
  "Late Night",
  "Vocal Clarity",
  "Warm & Musical",
  "Wide Soundstage",
]);
const flat: Settings = { tone: defaultTone, bands: [], bass: 0, treble: 0, gain: 0, pre_gain: 0, pan: 0, effects: [], bypass: false };
const emptyLibrary: Library = { input: "", output: "", settings: flat, presets: {}, device_presets: {} };
const noMeter: Meter = { status: "Waiting for audio", peak: [0, 0], spectrum: [], bass: 0 };
const ticks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const minorTicks = [30, 40, 60, 70, 80, 90].flatMap((hz) => [hz, hz * 10, hz * 100]);
const width = 900;
const height = 300;
const inset = 36;
const plotWidth = width - inset * 2;
const graphBottom = height - 28;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const x = (hz: number) => inset + Math.log10(hz / 20) / 3 * plotWidth;
const hzText = (hz: number) => hz >= 1000 ? `${hz / 1000}k` : String(hz);
const hasGain = (shape: Shape) => shape === "bell" || shape === "lowShelf" || shape === "highShelf";
const dbText = (db: number) => `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
const native = isTauri();
const colors = ["#73e0c2", "#83aaff", "#f398ad", "#eabe72", "#bca4ff", "#8cd5ef"];
const bandColor = (id: number) => colors[(id + colors.length - 1) % colors.length];
type Curves = [number, number[]][];
const filterIcons: Record<Shape, string> = {
  bell: "M1 12 C8 12 7 4 12 4 S16 12 23 12",
  lowShelf: "M1 5 H7 C12 5 12 12 17 12 H23",
  highShelf: "M1 12 H7 C12 12 12 5 17 5 H23",
  lowCut: "M1 16 C8 16 8 5 14 5 H23",
  highCut: "M1 5 H10 C16 5 16 16 23 16",
  notch: "M1 5 H7 C11 5 9 16 12 16 S13 5 17 5 H23",
};

function FilterIcon({ shape }: { shape: Shape }) {
  return <svg className="filter-icon" viewBox="0 0 24 18" aria-hidden="true">
    <path d={filterIcons[shape]} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>;
}

function spectrumPath(values: number[]) {
  const dx = plotWidth / Math.max(1, values.length - 1);
  const levels = values.map((db) => graphBottom - (clamp(db, -80, 0) + 80) / 80 * (graphBottom - 12));
  return levels.map((level, index) => {
    const right = inset + index * dx;
    if (!index) return `M${right},${level.toFixed(2)}`;
    const left = right - dx;
    const previous = levels[index - 1];
    const min = Math.min(level, previous);
    const max = Math.max(level, previous);
    const incoming = clamp(previous + (level - (levels[index - 2] ?? previous)) / 6, min, max);
    const outgoing = clamp(level - ((levels[index + 1] ?? level) - previous) / 6, min, max);
    return `C${(left + dx / 3).toFixed(2)},${incoming.toFixed(2)} ${(right - dx / 3).toFixed(2)},${outgoing.toFixed(2)} ${right.toFixed(2)},${level.toFixed(2)}`;
  }).join(" ");
}

function Graph({ bands, selected, select, change, add, remove, curves, spectrum, bypass, fast, range, colored }: {
  bands: Band[]; selected: number | null; select: (id: number | null) => void;
  change: (id: number, patch: Partial<Band>) => void; add: (hz: number, gain: number) => void;
  remove: (id: number) => void;
  curves: Curves; spectrum: number[]; bypass: boolean; fast: boolean; range: number; colored: boolean;
}) {
  const y = (db: number) => 12 + (range - clamp(db, -range, range)) / (2 * range) * (graphBottom - 12);
  const svg = useRef<SVGSVGElement>(null);
  const [context, setContext] = useState({ id: null as number | null, hz: 1000, gain: 0 });
  const spectrumShape = useRef<SVGPathElement>(null);
  const displayed = useRef<number[]>([]);
  useEffect(() => {
    const shape = spectrumShape.current;
    if (!shape || !spectrum.length) { displayed.current = []; return; }
    const weights = [1, 2, 3, 4, 3, 2, 1];
    const target = spectrum.map((_, index) => weights.reduce((sum, weight, offset) =>
      sum + weight * spectrum[clamp(index + offset - 3, 0, spectrum.length - 1)], 0) / 16);
    if (displayed.current.length !== target.length) displayed.current = target.slice();
    let frame = 0;
    let previous = performance.now();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const paint = (now: number) => {
      let moving = false;
      const dt = Math.min(40, now - previous);
      previous = now;
      displayed.current.forEach((value, index) => {
        const difference = target[index] - value;
        if (reduced || Math.abs(difference) < 0.045) displayed.current[index] = target[index];
        else {
          const ms = fast ? 50 : difference > 0 ? 85 : 170;
          displayed.current[index] += difference * (1 - Math.exp(-dt / ms));
          moving = true;
        }
      });
      shape.setAttribute("d", `${spectrumPath(displayed.current)} L${width - inset},${graphBottom} H${inset}Z`);
      if (moving) frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [spectrum, fast]);
  const drag = useRef<number | null>(null);
  const wheelControls = useRef({ bands, change, select });
  wheelControls.current = { bands, change, select };
  const [pixelScale, setPixelScale] = useState([1, 1]);
  useEffect(() => {
    const surface = svg.current;
    if (!surface) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width: renderedWidth, height: renderedHeight } = entry.contentRect;
      if (renderedWidth > 0 && renderedHeight > 0) {
        setPixelScale([width / renderedWidth, height / renderedHeight]);
      }
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const surface = svg.current;
    if (!surface) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY === 0) return;
      const target = event.target instanceof Element ? event.target.closest("[data-band-id]") : null;
      if (!target) return;
      const { bands, change, select } = wheelControls.current;
      const band = bands.find(({ id }) => id === Number(target.getAttribute("data-band-id")));
      if (!band) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
      const q = clamp(Math.round(band.q * Math.exp(-clamp(delta, -120, 120) / 650) * 1000) / 1000, 0.25, 12);
      select(band.id);
      change(band.id, { q });
    };
    surface.addEventListener("wheel", wheel, { passive: false });
    return () => surface.removeEventListener("wheel", wheel);
  }, []);
  const anchored = (left: number, top: number) =>
    `translate(${left},${top}) scale(${pixelScale.join(",")})`;
  const coords = (clientX: number, clientY: number) => {
    const surface = svg.current!;
    const matrix = surface.getScreenCTM();
    if (!matrix) return { hz: 1000, gain: 0 };
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return {
      hz: Math.round(clamp(20 * 1000 ** ((point.x - inset) / plotWidth), 20, 20000)),
      gain: Math.round(clamp(range - (point.y - 12) / (graphBottom - 12) * 2 * range, -range, range) * 10) / 10,
    };
  };
  const path = (values: number[], scale: (value: number) => number) => values.map((value, index) =>
    `${index === 0 ? "M" : "L"}${(inset + index / Math.max(values.length - 1, 1) * plotWidth).toFixed(2)},${scale(value).toFixed(2)}`,
  ).join(" ");
  const tone = useMemo(() => {
    if (bypass || !curves.length) return [0, 0];
    return curves[0][1].map((_, index) => curves.reduce((sum, [, values]) => sum + values[index], 0));
  }, [curves, bypass]);
  const update = (event: PointerEvent<SVGSVGElement>) => {
    const band = bands.find(({ id }) => id === drag.current);
    if (!band) return;
    const { hz, gain } = coords(event.clientX, event.clientY);
    change(band.id, { hz, ...(hasGain(band.shape) ? { gain } : {}) });
  };
  const targetBand = bands.find((band) => band.id === context.id);
  return <ContextActions items={targetBand ? [
    { label: targetBand.enabled ? "Bypass band" : "Enable band", icon: <Power aria-hidden="true" />, action: () => change(targetBand.id, { enabled: !targetBand.enabled }) },
    { label: "Reset band gain and Q", icon: <RotateCcw aria-hidden="true" />, action: () => change(targetBand.id, { gain: 0, q: 0.707 }) },
    { label: "Remove band", icon: <Trash2 aria-hidden="true" />, action: () => remove(targetBand.id) },
  ] : [{ label: "Add band here", icon: <Plus aria-hidden="true" />, disabled: bands.length >= 16, action: () => add(context.hz, context.gain) }]}>
    <svg ref={svg} className={`${bypass ? "graph bypassed" : "graph"}${colored ? " colored" : ""}`} viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none" aria-label="Frequency response"
      onContextMenu={(event) => {
        const node = (event.target as Element).closest("[data-band-id]");
        const id = node ? Number(node.getAttribute("data-band-id")) : null;
        setContext({ ...coords(event.clientX, event.clientY), id });
        if (id !== null) select(id);
      }}
      onDoubleClick={(event) => { if (!(event.target as Element).closest(".node")) {
        const point = coords(event.clientX, event.clientY); add(point.hz, point.gain);
      } }}
      onPointerDown={(event) => { if (!(event.target as Element).closest(".node")) select(null); }}
      onPointerMove={update} onPointerUp={() => { drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <defs>
        <linearGradient id="spectrum-fill" x2="0%" y2="100%">
          <stop stopColor="#8395ac" stopOpacity=".29" />
          <stop offset="1" stopColor="#8395ac" stopOpacity="0.025" />
        </linearGradient>
        <linearGradient id="spectrum-color-fill" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#7b9cff" stopOpacity=".36" />
          <stop offset="30%" stopColor="#6fe3c1" stopOpacity=".34" />
          <stop offset="60%" stopColor="#8cd5ef" stopOpacity=".32" />
          <stop offset="82%" stopColor="#f0c46c" stopOpacity=".34" />
          <stop offset="100%" stopColor="#f38ba8" stopOpacity=".36" />
        </linearGradient>
        <linearGradient id="curve-color-stroke" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#92afff" />
          <stop offset="30%" stopColor="#85f0cf" />
          <stop offset="60%" stopColor="#a2e3f8" />
          <stop offset="82%" stopColor="#f7d282" />
          <stop offset="100%" stopColor="#fca5be" />
        </linearGradient>
      </defs>
      {minorTicks.map((hz) => <line key={hz} className="grid minor" x1={x(hz)} x2={x(hz)} y1="12" y2={graphBottom} />)}
      {ticks.map((hz) => <g key={hz}><line className="grid" x1={x(hz)} x2={x(hz)} y1="12" y2={graphBottom} />
        <text transform={anchored(x(hz), height - 8)} textAnchor="middle">{hzText(hz)}</text></g>)}
      {[range, range * 2 / 3, range / 3, 0, -range / 3, -range * 2 / 3, -range].map((db) => <g key={db}>
        <line className={db ? "grid" : "zero"} x1={inset} x2={width - inset} y1={y(db)} y2={y(db)} />
        <text transform={anchored(width - 3, y(db))} dy="0.35em" textAnchor="end">{db > 0 ? `+${db}` : db}</text>
      </g>)}
      {spectrum.length > 0 && <path ref={spectrumShape} fill={colored ? "url(#spectrum-color-fill)" : "url(#spectrum-fill)"}
        stroke={colored ? "url(#curve-color-stroke)" : undefined} className="spectrum" />}
      {!bypass && curves.filter(([id]) => id < 0 || bands.some((band) => band.id === id && band.enabled)).map(([id, values]) => {
        const line = path(values, y);
        const ghost = id < 0;
        return <g key={id} className={ghost ? "band-response tone-ghost" : "band-response"}
          aria-label={ghost ? id === -1 ? "Bass response" : "Treble response" : undefined}
          style={{ color: id === -1 ? "#8bbad8" : id === -2 ? "#eabe72" : bandColor(id) }}
          opacity={!ghost && selected === id ? 1 : 0.65}>
          <path d={`${line} L${width - inset},${y(0)} H${inset}Z`} className="band-fill" />
          <path d={line} className="band-outline" vectorEffect="non-scaling-stroke" />
        </g>;
      })}
      <path d={path(tone, y)} className="curve" stroke={colored && !bypass ? "url(#curve-color-stroke)" : undefined} vectorEffect="non-scaling-stroke" />
      {bands.map((band, index) => <g className={`node ${selected === band.id ? "selected" : ""} ${band.enabled ? "" : "disabled"}`}
        key={band.id} data-band-id={band.id} style={{ color: bandColor(band.id) }}
        transform={anchored(x(band.hz), y(hasGain(band.shape) ? band.gain : 0))}
        role="button" tabIndex={0} aria-label={`Band ${index + 1}, ${band.hz} hertz`} aria-pressed={selected === band.id}
        onFocus={() => select(band.id)} onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(band.id); }
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            change(band.id, { hz: clamp(Math.round(band.hz * (event.key === "ArrowRight" ? 1.03 : 1 / 1.03)), 20, 20000) });
          }
          if (hasGain(band.shape) && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            change(band.id, { gain: clamp(band.gain + (event.key === "ArrowUp" ? 0.5 : -0.5), -range, range) });
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          select(band.id);
          drag.current = band.id;
          svg.current?.setPointerCapture(event.pointerId);
        }}>
        <title>Scroll to adjust Q</title>
        <circle r="17" className="hit" /><circle r="9" /><text textAnchor="middle" y="3.4">{index + 1}</text>
      </g>)}
    </svg>
  </ContextActions>;
}

function App() {
  const [data, setData] = useState(emptyLibrary);
  const [available, setAvailable] = useState<Device[]>([]);
  const [systemOutput, setSystemOutput] = useState("");
  const [meter, setMeter] = useState(noMeter);
  const [curves, setCurves] = useState<Curves>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [setup, setSetup] = useState(false);
  const [needsDriver, setNeedsDriver] = useState(false);
  const [rack, setRack] = useState(() => localStorage.getItem("equalizer.rack") !== "off");
  const [mixer, setMixer] = useState(() => localStorage.getItem("equalizer.mixer") !== "off");
  const [preferences, setPreferences] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"audio" | "analyzer" | "layout" | "tone">("audio")
  const [eqRange, setEqRange] = useState(() => clamp(Number(localStorage.getItem("equalizer.eqRange") ?? 18) || 18, 6, 36));
  const [showMeters, setShowMeters] = useState(() => localStorage.getItem("equalizer.meters") !== "off");
  const [showSpectrum, setShowSpectrum] = useState(() => localStorage.getItem("equalizer.spectrum") !== "off");
  const [graphColor, setGraphColor] = useState(() => localStorage.getItem("equalizer.graphColor") === "on");
  const [analyzerSpeed, setAnalyzerSpeed] = useState(() => localStorage.getItem("equalizer.analyzerSpeed") === "fast" ? "fast" : "smooth");
  const [restoreOptions, setRestoreOptions] = useState<Device[]>([]);
  const [speakerVolume, setSpeakerVolume] = useState<number | null>(null);
  const lastVolumeEdit = useRef(0);
  const volumePending = useRef<{ output: string; level: number } | null>(null);
  const volumeTimer = useRef<ReturnType<typeof setTimeout>>();
  const volumeWrites = useRef(Promise.resolve());
  const [save, setSave] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useRef(0);
  const pending = useRef<Settings | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const writes = useRef(Promise.resolve());
  const settings = data.settings;
  const band = settings.bands.find((band) => band.id === selected);

  function adopt(value: Library) {
    id.current = Math.max(id.current, 0, ...value.settings.bands.map((band) => band.id), ...value.settings.effects.map((effect) => effect.id));
    setData({ ...value, settings: { ...flat, ...value.settings } });
  }
  const report = (reason: unknown) => setError(String(reason));
  useEffect(() => {
    localStorage.setItem("equalizer.mixer", mixer ? "on" : "off");
    localStorage.setItem("equalizer.rack", rack ? "on" : "off");
    localStorage.setItem("equalizer.meters", showMeters ? "on" : "off");
  }, [mixer, rack, showMeters]);
  useEffect(() => {
    if (!native) return;
    let alive = true;
    let reading = false;
    const refresh = () => invoke<[Device[], string]>("devices").then(([devices, defaultId]) => {
      if (alive) { setAvailable(devices); setSystemOutput(defaultId); }
    }).catch(report);
    invoke<Library>("library").then((value) => { if (alive) adopt(value); }).catch(report);
    void refresh();
    const devicesTimer = setInterval(refresh, 1500);
    const meterTimer = setInterval(async () => {
      if (reading || document.hidden) return;
      reading = true;
      try {
        const value = await invoke<Meter>("meter");
        if (alive) setMeter(value);
      } catch (reason) { report(reason); }
      finally { reading = false; }
    }, 65);
    return () => { alive = false; clearInterval(devicesTimer); clearInterval(meterTimer); };
  }, []);

  useEffect(() => {
    setSpeakerVolume(null);
    if (!native || !data.output) return;
    let current = true;
    const read = () => invoke<number>("speaker_volume", { output: data.output, level: null }).then((level) => {
      if (current && Date.now() - lastVolumeEdit.current > 700) setSpeakerVolume(Math.round(level));
    }).catch(() => { if (current && Date.now() - lastVolumeEdit.current > 700) setSpeakerVolume(null); });
    void read();
    const interval = setInterval(read, 1000);
    return () => { current = false; clearInterval(interval); };
  }, [data.output]);

  function changeSpeakerVolume(level: number) {
    lastVolumeEdit.current = Date.now();
    setSpeakerVolume(level);
    volumePending.current = { output: data.output, level };
    if (volumeTimer.current !== undefined) return;
    volumeTimer.current = setTimeout(() => {
      volumeTimer.current = undefined;
      const change = volumePending.current;
      volumePending.current = null;
      if (change) volumeWrites.current = volumeWrites.current.then(async () => {
        await invoke<number>("speaker_volume", change);
      }).catch(report);
    }, 65);
  }

  useEffect(() => {
    if (!native) return;
    let current = true;
    invoke<Curves>("response", { settings }).then((next) => {
      if (current) setCurves(next);
    }).catch(report);
    return () => { current = false; };
  }, [settings]);

  function flush() {
    clearTimeout(timer.current);
    timer.current = undefined;
    const value = pending.current;
    pending.current = null;
    if (native && value) {
      writes.current = writes.current.then(() => invoke<void>("update_settings", { settings: value })).catch(report);
    }
    return writes.current;
  }
  function edit(patch: Partial<Settings>) {
    if (busy) return;
    const next = { ...settings, ...patch };
    setData({ ...data, settings: next });
    pending.current = next;
    if (timer.current === undefined) {
      timer.current = setTimeout(() => { timer.current = undefined; void flush(); }, 45);
    }
  }
  async function modify(action: string, args: Record<string, unknown>) {
    if (!native || busy) return;
    setBusy(true);
    clearTimeout(timer.current);
    timer.current = undefined;
    try {
      await flush();
      adopt(await invoke<Library>(action, args));
      setSelected(null);
      setSave(false);
      setError("");
    } catch (reason) { report(reason); }
    finally { setBusy(false); }
  }
  function selectRoute(input: string, output: string) {
    void modify("route", { input, output });
  }
  async function automaticSetup() {
    if (!native || busy) return;
    setBusy(true);
    setError("");
    try {
      await flush();
      const next = await invoke<Library | null>("auto_setup");
      if (!next) {
        setNeedsDriver(true);
        setSetup(true);
        return;
      }
      adopt(next);
      setSystemOutput(next.input);
      setNeedsDriver(false);
      setSetup(false);
    } catch (reason) {
      report(reason);
      setSetup(true);
    } finally {
      setBusy(false);
    }
  }
  async function turnOff(output?: string) {
    if (!native || busy) return;
    setBusy(true);
    setError("");
    try {
      await flush();
      const [next, options, defaultOutput] = await invoke<[Library | null, Device[], string]>("disable_routing", { output: output ?? null });
      if (next) {
        adopt(next);
        setSystemOutput(defaultOutput);
        setRestoreOptions([]);
      } else setRestoreOptions(options);
    } catch (reason) { report(reason); }
    finally { setBusy(false); }
  }
  function add(hz = 1000, gain = 0) {
    if (settings.bands.length >= 16 || busy) return;
    const idValue = ++id.current;
    edit({ bands: [...settings.bands, { id: idValue, hz, gain, q: 0.707, shape: "bell", enabled: true }] });
    setSelected(idValue);
  }
  function changeBand(id: number, patch: Partial<Band>) {
    edit({ bands: settings.bands.map((band) => band.id === id ? { ...band, ...patch } : band) });
  }
  function changeEffect(id: number, patch: Partial<Effect>) {
    edit({ effects: settings.effects.map((effect) => effect.id === id ? { ...effect, ...patch } : effect) });
  }
  function moveEffect(index: number, direction: number) {
    const effects = [...settings.effects];
    const [moved] = effects.splice(index, 1);
    effects.splice(index + direction, 0, moved);
    edit({ effects });
  }
  const associated = data.device_presets[data.output] || "";
  const waiting = !data.input || !data.output;
  const routingOn = !data.suspended && Boolean(data.input && data.input === systemOutput);
  const choices = (selectedId: string, excluded: string) => [
    ...(selectedId && !available.some(({ id }) => id === selectedId)
      ? [{ value: selectedId, label: "Disconnected" }] : []),
    ...available.filter(({ id }) => id !== excluded).map(({ id, name }) => ({ value: id, label: name })),
  ];
  const outputChoices = choices(data.output, "");
  const selectOutput = (output: string) => selectRoute(data.input === output ? "" : data.input, output);
  const inputChoices = choices(data.input, data.output);
  const presetNames = Object.keys(data.presets);
  const userPresets = presetNames.filter((item) => !builtinPresetNames.has(item));
  const builtinPresets = presetNames.filter((item) => builtinPresetNames.has(item));
  const presetGroups = [
    { label: "User presets", options: userPresets.map((item) => ({ value: item, label: item })) },
    { label: "Built-in", options: builtinPresets.map((item) => ({ value: item, label: item })) },
  ];
  const headerPresetGroups = [
    { options: [{ value: "__save__", label: "Save current…", icon: <Save aria-hidden="true" /> }] },
    ...presetGroups,
  ];
  const inputName = available.find(({ id }) => id === data.input)?.name;
  const defaultName = available.find(({ id }) => id === systemOutput)?.name;
  const notice = error && <div className="error" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>;
  return (
    <ContextActions items={[
      { label: "Settings", icon: <Settings2 aria-hidden="true" />, action: () => setPreferences(true) },
      { label: "Audio setup", icon: <MonitorCog aria-hidden="true" />, action: () => setSetup(true) },
      { label: mixer ? "Hide Mixer" : "Show Mixer", icon: <SlidersHorizontal aria-hidden="true" />, action: () => setMixer(!mixer) },
      { label: rack ? "Hide Effects" : "Show Effects", icon: <Layers aria-hidden="true" />, action: () => setRack(!rack) },
    ]}><main>
      <header className="header">
        <h1><button type="button" className="title-switch" aria-label={routingOn ? "Turn Equalizer off" : "Turn Equalizer on"}
          aria-pressed={routingOn} disabled={busy} onClick={() => routingOn ? void turnOff() : void automaticSetup()}>
          <span className="title-original" aria-hidden="true">Equalizer</span>
          <span className="title-action" aria-hidden="true"><Power />{routingOn ? "Turn off" : "Turn on"}</span>
        </button></h1>
        <div className="header-controls">
          <div className="output-preset-group" role="group" aria-label="Listening output and preset">
            <Dropdown label="Listening output" placeholder="Speakers or headphones" icon={<Headphones aria-hidden="true" />} value={data.output} disabled={busy}
              options={outputChoices} change={selectOutput} />
            <Dropdown label="Preset" value={associated} disabled={busy}
              groups={headerPresetGroups}
              change={(value) => {
                if (value === "__save__") { setName(associated); setSave(true); }
                else void modify("preset", { name: value, save: null });
              }} />
          </div>
          <button type="button" aria-label="Settings" aria-haspopup="dialog" onClick={() => setPreferences(true)}><Settings2 aria-hidden="true" /></button>
        </div>
      </header>
      {save && <Modal title="Save preset" close={() => setSave(false)}><form className="save" onSubmit={(event) => {
        event.preventDefault();
        void modify("preset", { name, save: settings });
      }}>
        <label className="field">Preset name
          <input autoFocus value={name} maxLength={64} required onChange={(event) => setName(event.target.value)} />
        </label>
        <button className="primary" disabled={busy || !name.trim()}><Save aria-hidden="true" />Save preset</button>
      </form>{notice}</Modal>}

      <div className="workspace">
      {mixer && <aside id="mixer-panel" className="mixer" aria-labelledby="mixer-title">
        <div className="mixer-header"><h2 id="mixer-title">Mixer</h2></div>
        {speakerVolume !== null && <Knob label="Speaker volume" shortLabel="Volume" min={0} max={100} step={1} reset={speakerVolume} value={speakerVolume}
          format={(level) => `${level}%`} change={changeSpeakerVolume} />}
        <Knob label="Pre gain" min={-24} max={24} step={0.5} reset={0} value={settings.pre_gain}
          format={dbText} change={(pre_gain) => edit({ pre_gain })} />
        <Knob label="Post gain" min={-24} max={24} step={0.5} reset={0} value={settings.gain}
          format={dbText} change={(gain) => edit({ gain })} />
        <Knob label="Pan" min={-100} max={100} step={1} reset={0} value={settings.pan}
          format={(pan) => pan === 0 ? "Center" : `${Math.abs(pan)}% ${pan < 0 ? "L" : "R"}`} change={(pan) => edit({ pan })} />
      </aside>}
      {mixer && <SidebarDivider side="left" target="mixer-panel" />}
      <div className="equalizer-workspace">
      <section className="equalizer" aria-label="Parametric equalizer">
        <div className="section-top">
          <span className="status"><i className={meter.status === "Active" && routingOn && !waiting ? "live" : ""} />
            {data.suspended ? "Equalizer off" : waiting ? "Audio setup required" : !inputName ? "Virtual playback device disconnected"
              : data.input !== systemOutput ? "Set the virtual device as Windows output" : meter.status}</span>
          <div className="actions">
            <button aria-pressed={settings.bypass} onClick={() => edit({ bypass: !settings.bypass })}><Power aria-hidden="true" />Bypass</button>
            <button aria-haspopup="dialog" disabled={busy} onClick={() => {
              if (waiting || data.input !== systemOutput) void automaticSetup();
              else setSetup(true);
            }}><MonitorCog aria-hidden="true" />{busy ? "Working…" : waiting || data.input !== systemOutput ? "Set up audio" : "Setup"}</button>
          </div>
        </div>
        <div className="graph-stage">
          <Graph bands={settings.bands} selected={selected} select={setSelected} add={add} change={changeBand}
            remove={(id) => { edit({ bands: settings.bands.filter((item) => item.id !== id) }); setSelected(null); }}
            curves={curves} spectrum={showSpectrum && !data.suspended ? meter.spectrum : []} bypass={settings.bypass}
            fast={analyzerSpeed === "fast"} range={eqRange} colored={graphColor} />
          {showMeters && <div className="meters" aria-label="Output levels">
            <div className="meter-tracks">
              {meter.peak.map((peak, channel) => {
                const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
                const percent = (clamp(db, -60, 0) + 60) / 60 * 100;
                return <div key={channel} className="meter-track" role="meter" aria-label={channel ? "Right output" : "Left output"}
                  aria-valuemin={-60} aria-valuemax={0} aria-valuenow={clamp(db, -60, 0)}
                  aria-valuetext={db < -60 ? "Below −60 dB" : dbText(db)}>
                  <div className="meter-level" style={{ clipPath: `inset(${100 - percent}% 0 0)` }} />
                </div>;
              })}
            </div>
            <span>Out</span>
          </div>}
        </div>
        <div className="inspector">
          {band ? <>
            <Dropdown label="Filter shape" value={band.shape} change={(shape) => changeBand(band.id, { shape: shape as Shape })}
              options={Object.entries(shapes).map(([value, label]) => ({ value, label, icon: <FilterIcon shape={value as Shape} /> }))} />
            <Knob label="Frequency" value={band.hz} min={20} max={20000} step={1} logarithmic reset={1000}
              format={(hz) => `${hz} Hz`} change={(hz) => changeBand(band.id, { hz })} />
            {hasGain(band.shape) && <Knob label="Gain" value={band.gain} min={Math.min(-eqRange, band.gain)}
              max={Math.max(eqRange, band.gain)} step={0.1} reset={0}
              format={dbText} change={(gain) => changeBand(band.id, { gain })} />}
            <Knob label="Q" value={band.q} min={0.25} max={12} step={0.01} logarithmic reset={0.707}
              format={(q) => q.toFixed(2)} change={(q) => changeBand(band.id, { q })} />
            <button aria-label="Bypass band" title="Bypass band" aria-pressed={!band.enabled}
              onClick={() => changeBand(band.id, { enabled: !band.enabled })}><Power aria-hidden="true" /></button>
            <button aria-label="Remove band" title="Remove band"
              onClick={() => { edit({ bands: settings.bands.filter(({ id }) => id !== band.id) }); setSelected(null); }}><Trash2 aria-hidden="true" /></button>
          </> : <span className="muted">Double-click the graph to add a band.</span>}
          <button className="add-band" onClick={() => add()} disabled={settings.bands.length >= 16}><Plus aria-hidden="true" />Add band</button>
        </div>
      </section>

      <footer className="bottom">
        <Knob label="Bass" min={0} max={Math.max(eqRange, settings.bass)} step={0.1} value={settings.bass} format={dbText}
          change={(bass) => edit({ bass })} />
        <Knob label="Treble" min={-12} max={12} step={0.1} reset={0} value={settings.treble} format={dbText}
          change={(treble) => edit({ treble })} />
        <Knob label="EQ range" min={6} max={36} step={3} reset={18} value={eqRange}
          format={(value) => `\u00B1${value} dB`} change={(value) => {
            const range = Math.round(value / 3) * 3;
            setEqRange(range);
            localStorage.setItem("equalizer.eqRange", String(range));
          }} />
        <div className="panel-toggles">
          <button aria-expanded={mixer} aria-controls={mixer ? "mixer-panel" : undefined}
            onClick={() => setMixer(!mixer)}><SlidersHorizontal aria-hidden="true" />Mixer</button>
          <button aria-expanded={rack} aria-controls={rack ? "effects-rack" : undefined}
            onClick={() => setRack(!rack)}><Layers aria-hidden="true" />Effects{settings.effects.length > 0 && <span>{settings.effects.length}</span>}</button>
        </div>
      </footer>
      </div>
      {rack && <SidebarDivider side="right" target="effects-rack" />}
      {rack && <EffectRack effects={settings.effects} change={changeEffect} move={moveEffect} reductions={meter.compression ?? []}
        stereo={data.suspended ? null : meter.stereo}
        trace={data.suspended ? null : meter.scope}
        remove={(id) => edit({ effects: settings.effects.filter((effect) => effect.id !== id) })}
        add={(kind) => edit({ effects: [...settings.effects, { id: ++id.current, kind, enabled: true, amount: effectSpecs[kind].initial }] })} />}
      </div>

      {restoreOptions.length > 0 && <Modal title="Choose a listening output" close={() => setRestoreOptions([])}>
        <p>Choose where Windows should play audio when Equalizer turns off.</p>
        <div className="routing-options">{restoreOptions.map((option) =>
          <button key={option.id} disabled={busy} onClick={() => void turnOff(option.id)}><Headphones aria-hidden="true" />{option.name}</button>)}</div>
        {notice}
      </Modal>}
      {preferences && <Modal title="Settings" close={() => setPreferences(false)}>
        <div className="settings-layout">
          <div className="settings-tabs" role="tablist" aria-label="Settings sections" aria-orientation="vertical"
            onKeyDown={(event) => {
              const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")];
              const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
              const target = event.key === "ArrowDown" ? (index + 1) % tabs.length
                : event.key === "ArrowUp" ? (index + tabs.length - 1) % tabs.length
                : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
              if (target < 0) return;
              event.preventDefault();
              tabs[target].focus();
              tabs[target].click();
            }}>
            {([
              ["audio", "Audio", Headphones], ["analyzer", "Analyzer", AudioLines], ["tone", "Tone", SlidersHorizontal], ["layout", "Layout", Layers],
            ] as const).map(([key, label, Icon]) => <button type="button" key={key} role="tab" id={`settings-tab-${key}`}
              aria-selected={settingsTab === key} aria-controls={`settings-panel-${key}`} tabIndex={settingsTab === key ? 0 : -1}
              onClick={() => setSettingsTab(key)}><Icon aria-hidden="true" />{label}</button>)}
          </div>
          <div className="preferences" role="tabpanel" id={`settings-panel-${settingsTab}`} aria-labelledby={`settings-tab-${settingsTab}`}>
          {settingsTab === "audio" && <>
            <Dropdown label="Listening output" placeholder="Speakers or headphones" value={data.output}
              disabled={busy} options={outputChoices} change={selectOutput} />
            {speakerVolume !== null && <Knob label="Speaker volume" min={0} max={100} step={1} reset={speakerVolume}
              value={speakerVolume} format={(level) => `${level}%`} change={changeSpeakerVolume} />}
            <div className="device-presets">
              <h3>Device presets</h3>
              {available.filter(({ id }) => id !== data.input).map((device) => (
                <div key={device.id} className="device-preset-row">
                  <span title={device.name}>{device.name}</span>
                  <Dropdown label={`Preset for ${device.name}`} placeholder="None"
                    value={data.device_presets[device.id] || "__none__"}
                    disabled={busy}
                    groups={[{ options: [{ value: "__none__", label: "None" }] }, ...presetGroups]}
                    change={(value) => void modify("assign_device_preset", { device: device.id, preset: value === "__none__" ? "" : value })} />
                </div>
              ))}
            </div>
            <button onClick={() => { setPreferences(false); setSetup(true); }}><MonitorCog aria-hidden="true" />Audio setup</button>
            <button onClick={() => invoke("sound_settings").catch(report)}><Settings2 aria-hidden="true" />Windows sound settings</button>
            {notice}
          </>}
          {settingsTab === "analyzer" && <>
          <label><AudioLines aria-hidden="true" />Show live spectrum
            <input type="checkbox" checked={showSpectrum} onChange={(event) => {
              setShowSpectrum(event.target.checked);
              localStorage.setItem("equalizer.spectrum", event.target.checked ? "on" : "off");
            }} />
          </label>
          <label><Palette aria-hidden="true" />Show color in EQ graph
            <input type="checkbox" checked={graphColor} onChange={(event) => {
              setGraphColor(event.target.checked);
              localStorage.setItem("equalizer.graphColor", event.target.checked ? "on" : "off");
            }} />
          </label>
          <div><Activity aria-hidden="true" />Analyzer response
            <Dropdown label="Analyzer response" value={analyzerSpeed} disabled={!showSpectrum}
              options={[{ value: "smooth", label: "Smooth" }, { value: "fast", label: "Fast" }]}
              change={(value) => {
                const next = value === "fast" ? "fast" : "smooth";
                setAnalyzerSpeed(next);
                localStorage.setItem("equalizer.analyzerSpeed", next);
              }} />
          </div>
          <label><ChartNoAxesColumn aria-hidden="true" />Show output meters
            <input type="checkbox" checked={showMeters} onChange={(event) => setShowMeters(event.target.checked)} />
          </label>
          </>}
          {settingsTab === "tone" && <div className="tone-settings">
            <label className="tone-protection"><Activity aria-hidden="true" />Bass peak protection
              <input type="checkbox" checked={!settings.disable_bass_protection}
                onChange={(event) => edit({ disable_bass_protection: !event.target.checked })} />
            </label>
            {(["bass", "treble"] as const).map((kind) => {
              const hz = `${kind}_hz` as const;
              const q = `${kind}_q` as const;
              const label = kind === "bass" ? "Bass" : "Treble";
              return <section key={kind}><h3>{label}</h3>
                <Knob label={`${label} frequency`} shortLabel="Frequency" min={kind === "bass" ? 20 : 1000}
                  max={kind === "bass" ? 1000 : 16000} step={1} logarithmic reset={defaultTone[hz]}
                  value={settings.tone[hz]} format={(value) => `${value} Hz`}
                  change={(value) => edit({ tone: { ...settings.tone, [hz]: value } })} />
                <Knob label={`${label} Q`} shortLabel="Q" min={0.25} max={2} step={0.01}
                  reset={defaultTone[q]} value={settings.tone[q]} format={(value) => value.toFixed(2)}
                  change={(value) => edit({ tone: { ...settings.tone, [q]: value } })} />
              </section>;
            })}
          </div>}
          {settingsTab === "layout" && <>
            <label><Minimize2 aria-hidden="true" />Minimize to tray on close<input type="checkbox" checked={!data.quit_on_close} onChange={(event) => {
              const quit = !event.target.checked;
              const update = () => setData((current) => ({ ...current, quit_on_close: quit }));
              if (native) void invoke("set_close_behavior", { quit }).then(update).catch(report);
              else update();
            }} /></label>
            <label><SlidersHorizontal aria-hidden="true" />Show Mixer<input type="checkbox" checked={mixer} onChange={(event) => setMixer(event.target.checked)} /></label>
            <label><Layers aria-hidden="true" />Show Effects<input type="checkbox" checked={rack} onChange={(event) => setRack(event.target.checked)} /></label>
            <button onClick={() => {
              document.getElementById("mixer-panel")?.style.removeProperty("flex-basis");
              document.getElementById("effects-rack")?.style.removeProperty("flex-basis");
              setMixer(true);
              setRack(true);
            }}><RefreshCw aria-hidden="true" />Reset sidebars</button>
          </>}
          </div>
        </div>
      </Modal>}
      {setup && <Modal title="Audio setup" close={() => setSetup(false)}>
        {needsDriver ? <>
          <p>Equalizer needs a virtual playback driver for Windows audio. Install VB-CABLE once, then return here and Equalizer will handle the routing.</p>
          <div className="actions">
            <button className="primary" onClick={() => invoke("driver_website").catch(report)}><Download aria-hidden="true" />Get VB-CABLE</button>
            <button disabled={busy} onClick={() => void automaticSetup()}><RefreshCw aria-hidden="true" />{busy ? "Setting up…" : "Try again"}</button>
          </div>
        </> : <p>{data.input && data.input === systemOutput
          ? "Windows audio is routed through Equalizer."
          : "Equalizer can use an installed virtual cable and your current listening device automatically."}</p>}
        <details className="manual-setup">
        <summary>Manual routing</summary>
        <p>Windows sends audio to a virtual playback device. Equalizer reads it there and plays the result through your speakers or headphones.</p>
        <ol className="setup-steps">
          <li><div className="field">Listening output
            <Dropdown label="Listening output" placeholder="Speakers or headphones" value={data.output} disabled={busy}
              options={outputChoices} change={selectOutput} />
          </div></li>
          <li><div className="field">Virtual playback device
            <Dropdown label="Virtual playback device" placeholder="Choose virtual playback device" value={data.input}
              disabled={busy || !data.output} options={inputChoices} change={(input) => selectRoute(input, data.output)} />
          </div>
            <p className="muted">{data.output && inputChoices.length === 0
              ? "Windows only lists your listening output. Install a virtual audio device to continue."
              : "Choose your virtual cable’s playback endpoint. For VB-CABLE, choose CABLE Input."}</p>
            <p className="muted">This build requires a separately installed virtual audio driver.</p>
          </li>
          <li><button onClick={() => invoke("sound_settings").catch(report)}><MonitorCog aria-hidden="true" />Windows sound settings</button>
            <p className="muted">{inputName && data.input === systemOutput
              ? `${inputName} is the current Windows output. Play some audio and check the Equalizer meters.`
              : `Set ${inputName ?? "the virtual playback device"} as Windows’ default output.${defaultName ? ` Current output is ${defaultName}.` : ""}`}</p>
          </li>
        </ol>
        <p className="muted">If you route audio manually, switch Windows back to your listening output before quitting from the system tray.</p>
        </details>
        {notice}
      </Modal>}
      {!setup && !save && !restoreOptions.length && notice}
    </main></ContextActions>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
