# Equalizer

A Windows desktop equalizer with a Rust audio engine and a Tauri interface. It includes stereo parametric EQ, adaptive bass, treble, a live spectrum, per-output presets, and a reorderable effects rack.

**Stereo Width** and **Spatial Expander** show the stereo output on a live vectorscope. Add **Spectrogram** from the Effects menu to see separate left and right frequency histories. The Spectrogram insert only analyzes the output.

The Windows release is a standalone x64 executable. Audio routing requires a compatible virtual playback driver such as [VB-CABLE](https://vb-audio.com/Cable/).

## Run on Windows 11 x64

Install Node.js, the Rust MSVC toolchain, Visual Studio C++ build tools, and WebView2. From this directory:

```powershell
npm ci
npm run tauri dev
```

1. Install [VB-CABLE](https://vb-audio.com/Cable/) separately if a compatible virtual playback driver is missing.
2. Click **Set up audio**. Equalizer finds the virtual cable, keeps the selected listening output or uses the Windows default, and switches Windows playback to the cable.
3. Play music and check the Equalizer meters. Turn the **Bass** knob or double-click the graph to add a band. Pair Bluetooth headphones in Windows before choosing them as the listening output.

Closing the window hides the app to the tray and playback continues. Quitting from the tray restores the previous Windows playback defaults after automatic setup. If you routed audio manually, switch Windows back to a physical output before quitting. Apps routed directly to another output play outside this signal path.

The virtual endpoint's shared-mode mix feeds the EQ. The Bass control uses available headroom to bring up the lows and reduces the requested boost as peaks approach the limit. The output limiter remains active during bypass.

## Checks

```powershell
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

The tests compare the graph's bell response against processed audio, check the Bass control with and without headroom, and exercise the limiter with a signal whose peaks fall between samples.

## Release status

This development build requires an existing virtual playback endpoint. The bundled SysVAD-derived driver, the signed driver installer, and the isolated VST3 host are pending. Physical and Bluetooth playback, recovery after device changes, sustained underrun rate, and end-to-end latency need hardware verification.
