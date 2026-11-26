import { useEffect, useRef } from "react";

export type StereoBands = [number[], number[]];

const columns = 192;
const lane = 44;
const rows = lane * 2 + 2;
const palette = [
  [18, 21, 27], [33, 52, 83], [70, 98, 155],
  [57, 177, 190], [174, 231, 194], [252, 244, 210],
];
const colors = Array.from({ length: 101 }, (_, index) => {
  const at = index / 100 * (palette.length - 1);
  const low = palette[Math.floor(at)];
  const high = palette[Math.min(palette.length - 1, Math.ceil(at))];
  return low.map((value, channel) => Math.round(value + (high[channel] - value) * (at % 1)));
});

export function StereoSpectrogram({ bands, onDoubleClick }: { bands?: StereoBands | null; onDoubleClick?: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const column = useRef<ImageData>();
  useEffect(() => {
    const surface = canvas.current;
    const ctx = surface?.getContext("2d");
    if (!surface || !ctx) return;
    if (!bands?.[0].length || !bands[1].length) {
      ctx.clearRect(0, 0, columns, rows);
      return;
    }
    const image = column.current ??= ctx.createImageData(1, rows);
    bands.forEach((channel, index) => {
      for (let row = 0; row < lane; row++) {
        const lower = Math.floor((lane - 1 - row) * channel.length / lane);
        const upper = Math.max(lower + 1, Math.ceil((lane - row) * channel.length / lane));
        let db = -80;
        for (let bin = lower; bin < upper; bin++) db = Math.max(db, channel[bin]);
        const intensity = Math.round(Math.min(1, Math.max(0, (db + 78) / 75)) * 100);
        const base = (index * (lane + 2) + row) * 4;
        image.data.set(colors[intensity], base);
        image.data[base + 3] = 255;
      }
    });
    ctx.drawImage(surface, 1, 0, columns - 1, rows, 0, 0, columns - 1, rows);
    ctx.putImageData(image, columns - 1, 0);
  }, [bands]);
  return <figure className="stereo-spectrogram">
    <figcaption>Output spectrogram</figcaption>
    <div className="stereo-plot" onDoubleClick={onDoubleClick} title={onDoubleClick ? "Double-click to enlarge" : undefined}>
      <div className="stereo-channels" aria-hidden="true"><span>L</span><span>R</span></div>
      <canvas ref={canvas} width={columns} height={rows} role="img"
        aria-label="Live left and right output spectrogram. Low frequencies at the bottom of each lane." />
    </div>
  </figure>;
}
