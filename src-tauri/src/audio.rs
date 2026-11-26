use crate::dsp::{EffectKind, Engine, Frame, Settings, RATE};
use serde::Serialize;
use std::{
    collections::VecDeque,
    ptr,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use windows::{
    core::{IUnknown_Vtbl, Interface, GUID, HRESULT, PCWSTR, PWSTR},
    Win32::{
        Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
        Foundation::{CloseHandle, HANDLE, WAIT_FAILED},
        Media::Audio::*,
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                StructuredStorage::{PropVariantClear, PropVariantToStringAlloc},
                CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
            },
            Threading::{
                AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, CreateEventW,
                WaitForMultipleObjects,
            },
        },
    },
};

#[derive(Clone, Serialize)]
pub struct Device {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Default, PartialEq)]
pub struct Route {
    pub input: String,
    pub output: String,
}

#[derive(Clone, Serialize)]
pub struct Meter {
    pub status: String,
    pub peak: Frame,
    pub spectrum: Vec<f32>,
    pub stereo: Option<[Vec<f32>; 2]>,
    pub scope: Option<Vec<Frame>>,
    pub bass: f32,
    pub compression: Vec<(u32, f32)>,
}

impl Meter {
    fn status(status: impl Into<String>) -> Self {
        Self {
            status: status.into(),
            peak: [0.; 2],
            spectrum: Vec::new(),
            stereo: None,
            scope: None,
            bass: 0.,
            compression: Vec::new(),
        }
    }
}

pub struct Audio {
    pub controls: Mutex<(Route, Settings, u64)>,
    pub meter: Mutex<Meter>,
}

impl Audio {
    pub fn start(route: Route, settings: Settings) -> Arc<Self> {
        let audio = Arc::new(Self {
            controls: Mutex::new((route, settings, 0)),
            meter: Mutex::new(Meter::status("Choose an input and output")),
        });
        let worker = Arc::clone(&audio);
        thread::spawn(move || {
            if let Err(error) = run(&worker) {
                *worker.meter.lock().unwrap() = Meter::status(error.to_string());
            }
        });
        audio
    }
}

struct Com;
impl Com {
    fn init() -> windows::core::Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
        Ok(Self)
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}

fn enumerator() -> windows::core::Result<IMMDeviceEnumerator> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

unsafe fn take_string(value: PWSTR) -> String {
    let result = value.to_string().unwrap_or_default();
    CoTaskMemFree(Some(value.0.cast()));
    result
}

pub fn devices() -> windows::core::Result<(Vec<Device>, String)> {
    let _com = Com::init()?;
    let api = enumerator()?;
    unsafe {
        let default = api
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .and_then(|device| device.GetId())
            .map(|id| take_string(id))
            .unwrap_or_default();
        let list = api.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        let mut result = Vec::new();
        for index in 0..list.GetCount()? {
            let device = list.Item(index)?;
            let id = take_string(device.GetId()?);
            let name = (|| {
                let properties = device.OpenPropertyStore(STGM_READ)?;
                let mut value = properties.GetValue(&PKEY_Device_FriendlyName)?;
                let name = PropVariantToStringAlloc(&value).map(|name| take_string(name));
                let _ = PropVariantClear(&mut value);
                name
            })()
            .unwrap_or_else(|_: windows::core::Error| id.clone());
            result.push(Device { id, name });
        }
        Ok((result, default))
    }
}

const PLAYBACK_ROLES: [ERole; 2] = [eConsole, eMultimedia];

fn role_defaults(api: &IMMDeviceEnumerator) -> [String; 2] {
    PLAYBACK_ROLES.map(|role| unsafe {
        api.GetDefaultAudioEndpoint(eRender, role)
            .and_then(|device| device.GetId())
            .map(|id| take_string(id))
            .unwrap_or_default()
    })
}

pub fn playback_defaults() -> windows::core::Result<[String; 2]> {
    let _com = Com::init()?;
    Ok(role_defaults(&enumerator()?))
}

// Windows exposes this COM interface to audio policy clients. Its ABI is not in the SDK.
windows::core::imp::define_interface!(
    PlaybackPolicy,
    PlaybackPolicyVtbl,
    0x568b9108_44bf_40b4_9006_86afe5b5a620
);
#[repr(C)]
pub struct PlaybackPolicyVtbl {
    base: IUnknown_Vtbl,
    unused: [usize; 9],
    set_default_endpoint:
        unsafe extern "system" fn(*mut std::ffi::c_void, PCWSTR, ERole) -> HRESULT,
}

pub fn set_playback_defaults(desired: [&str; 2]) -> windows::core::Result<()> {
    let _com = Com::init()?;
    let api = enumerator()?;
    let before = role_defaults(&api);
    if desired
        .iter()
        .zip(&before)
        .all(|(id, current)| id.is_empty() || *id == current)
    {
        return Ok(());
    }
    let class = GUID::from_u128(0x294935ce_f637_4e7c_a41b_ab255460b862);
    let policy: PlaybackPolicy = unsafe { CoCreateInstance(&class, None, CLSCTX_ALL)? };
    let set = |id: &str, role| {
        let utf16: Vec<_> = id.encode_utf16().chain([0]).collect();
        unsafe {
            (policy.vtable().set_default_endpoint)(policy.as_raw(), PCWSTR(utf16.as_ptr()), role)
                .ok()
        }
    };
    for (index, id) in desired.into_iter().enumerate() {
        if id.is_empty() || id == before[index] {
            continue;
        }
        if let Err(error) = set(id, PLAYBACK_ROLES[index]) {
            for previous in 0..index {
                if !before[previous].is_empty() && before[previous] != desired[previous] {
                    let _ = set(&before[previous], PLAYBACK_ROLES[previous]);
                }
            }
            return Err(error);
        }
    }
    Ok(())
}

pub fn check_route(input: &str, output: &str) -> windows::core::Result<()> {
    let _com = Com::init()?;
    let api = enumerator()?;
    let capture = Stream::open(&api, input, true)?;
    let playback = Stream::open(&api, output, false)?;
    unsafe {
        capture.client.GetService::<IAudioCaptureClient>()?;
        playback.client.GetService::<IAudioRenderClient>()?;
    }
    Ok(())
}

pub fn endpoint_volume(id: &str, scalar: Option<f32>) -> windows::core::Result<f32> {
    let _com = Com::init()?;
    let api = enumerator()?;
    let id: Vec<_> = id.encode_utf16().chain([0]).collect();
    unsafe {
        let device = api.GetDevice(PCWSTR(id.as_ptr()))?;
        let volume: Endpoints::IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None)?;
        if let Some(level) = scalar {
            volume.SetMasterVolumeLevelScalar(level, ptr::null())?;
        }
        volume.GetMasterVolumeLevelScalar()
    }
}

struct Event(HANDLE);
impl Event {
    fn new() -> windows::core::Result<Self> {
        unsafe { Ok(Self(CreateEventW(None, false, false, None)?)) }
    }
}
impl Drop for Event {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct AudioPriority(HANDLE);

impl AudioPriority {
    fn register() -> Option<Self> {
        let mut task_index = 0;
        unsafe {
            AvSetMmThreadCharacteristicsW(windows::core::w!("Pro Audio"), &mut task_index)
                .ok()
                .map(Self)
        }
    }
}

impl Drop for AudioPriority {
    fn drop(&mut self) {
        unsafe {
            let _ = AvRevertMmThreadCharacteristics(self.0);
        }
    }
}

struct Stream {
    client: IAudioClient,
    event: Event,
    capacity: u32,
}
impl Stream {
    fn open(api: &IMMDeviceEnumerator, id: &str, capture: bool) -> windows::core::Result<Self> {
        let id: Vec<_> = id.encode_utf16().chain([0]).collect();
        let format = WAVEFORMATEX {
            wFormatTag: 3,
            nChannels: 2,
            nSamplesPerSec: 48_000,
            nAvgBytesPerSec: 384_000,
            nBlockAlign: 8,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        let event = Event::new()?;
        let flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK
            | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
            | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
            | if capture {
                AUDCLNT_STREAMFLAGS_LOOPBACK
            } else {
                0
            };
        unsafe {
            let endpoint = api.GetDevice(PCWSTR(id.as_ptr()))?;
            let client: IAudioClient = endpoint.Activate(CLSCTX_ALL, None)?;
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200_000, 0, &format, None)?;
            client.SetEventHandle(event.0)?;
            let capacity = client.GetBufferSize()?;
            Ok(Self {
                client,
                event,
                capacity,
            })
        }
    }
}
impl Drop for Stream {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
        }
    }
}

const FFT: usize = 2048;
struct Analyzer {
    samples: [Frame; FFT],
    next: usize,
    peak: Frame,
}

impl Analyzer {
    fn push(&mut self, frame: Frame) {
        self.samples[self.next] = frame;
        self.next = (self.next + 1) % FFT;
        for (peak, sample) in self.peak.iter_mut().zip(frame) {
            *peak = peak.max(sample.abs());
        }
    }

    fn spectra(&self, show_stereo: bool) -> (Vec<f32>, Option<[Vec<f32>; 2]>) {
        // Pack the two real channels into one complex transform.
        let mut bins: [[f32; 2]; FFT] = std::array::from_fn(|i| {
            let [left, right] = self.samples[(self.next + i) % FFT];
            let window = 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / FFT as f32).cos();
            if show_stereo {
                [left * window, right * window]
            } else {
                [(left + right) * 0.5 * window, 0.]
            }
        });
        for i in 0..FFT {
            let reverse = i.reverse_bits() >> (usize::BITS - FFT.ilog2());
            if reverse > i {
                bins.swap(i, reverse);
            }
        }
        let mut width = 2;
        while width <= FFT {
            let half = width / 2;
            for offset in 0..half {
                let angle = -std::f32::consts::TAU * offset as f32 / width as f32;
                let (s, c) = angle.sin_cos();
                for block in bins.chunks_exact_mut(width) {
                    let [r, i] = block[offset + half];
                    let rotated = [c * r - s * i, s * r + c * i];
                    for (axis, value) in rotated.into_iter().enumerate() {
                        let even = block[offset][axis];
                        block[offset][axis] = even + value;
                        block[offset + half][axis] = even - value;
                    }
                }
            }
            width *= 2;
        }
        let magnitudes = |index: usize| {
            let [real, imag] = bins[index];
            if !show_stereo {
                return [real.hypot(imag), 0., 0.];
            }
            let [mirror_real, mirror_imag] = bins[(FFT - index) % FFT];
            let left = [(real + mirror_real) * 0.5, (imag - mirror_imag) * 0.5];
            let right = [(imag + mirror_imag) * 0.5, (mirror_real - real) * 0.5];
            [
                (left[0] + right[0]).hypot(left[1] + right[1]) * 0.5,
                left[0].hypot(left[1]),
                right[0].hypot(right[1]),
            ]
        };
        let mut spectrum = Vec::with_capacity(121);
        let mut stereo = show_stereo.then(|| [Vec::with_capacity(121), Vec::with_capacity(121)]);
        for index in 0..=120 {
            let hz = 20. * 1000f32.powf(index as f32 / 120.);
            let bin = hz * FFT as f32 / RATE as f32;
            let lower = bin.floor() as usize;
            let low = magnitudes(lower);
            let high = magnitudes(lower + 1);
            let decibels = |channel: usize| {
                let level = low[channel] + (high[channel] - low[channel]) * bin.fract();
                20. * (level * 4. / FFT as f32).max(0.0001).log10()
            };
            spectrum.push(decibels(0));
            if let Some(channels) = &mut stereo {
                channels[0].push(decibels(1));
                channels[1].push(decibels(2));
            }
        }
        (spectrum, stereo)
    }

    fn snapshot(
        &mut self,
        bass: f32,
        compression: Vec<(u32, f32)>,
        publishing: bool,
        show_stereo: bool,
        show_scope: bool,
    ) -> Meter {
        let (spectrum, stereo) = self.spectra(show_stereo);
        let scope = show_scope.then(|| {
            const POINTS: usize = 128;
            const STRIDE: usize = 4;
            (0..POINTS)
                .map(|point| {
                    self.samples[(self.next + FFT - POINTS * STRIDE + point * STRIDE) % FFT]
                })
                .collect()
        });
        Meter {
            status: if publishing {
                "Active"
            } else {
                "Waiting for Windows audio"
            }
            .into(),
            peak: std::mem::take(&mut self.peak),
            spectrum,
            stereo,
            scope,
            bass,
            compression,
        }
    }
}

fn run(audio: &Audio) -> windows::core::Result<()> {
    let _com = Com::init()?;
    let api = enumerator()?;
    loop {
        let route = audio.controls.lock().unwrap().0.clone();
        if route.input.is_empty() || route.output.is_empty() || route.input == route.output {
            *audio.meter.lock().unwrap() =
                Meter::status("Choose separate input and output devices");
        } else if let Err(error) = play(audio, &api, route) {
            *audio.meter.lock().unwrap() = Meter::status(format!("Audio unavailable · {error}"));
        }
        thread::sleep(Duration::from_millis(450));
    }
}

fn play(audio: &Audio, api: &IMMDeviceEnumerator, route: Route) -> windows::core::Result<()> {
    let input = Stream::open(api, &route.input, true)?;
    let output = Stream::open(api, &route.output, false)?;
    let mut engine = Engine::new();
    let mut version = None;
    let mut show_stereo = false;
    let mut show_scope = false;
    let mut queue = VecDeque::<Frame>::with_capacity(8192);
    let mut phase = 0.;
    let mut ratio = 1.;
    let mut primed = false;
    let mut last_audio = Instant::now();
    let mut last_meter = Instant::now();
    let mut analyzer = Analyzer {
        samples: [[0.; 2]; FFT],
        next: 0,
        peak: [0.; 2],
    };
    let handles = [input.event.0, output.event.0];
    let _priority = AudioPriority::register();
    unsafe {
        let capture: IAudioCaptureClient = input.client.GetService()?;
        let render: IAudioRenderClient = output.client.GetService()?;
        render.GetBuffer(output.capacity)?;
        render.ReleaseBuffer(output.capacity, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)?;
        input.client.Start()?;
        output.client.Start()?;
        loop {
            if WaitForMultipleObjects(&handles, false, 100) == WAIT_FAILED {
                return Err(windows::core::Error::from_thread());
            }
            if let Ok(controls) = audio.controls.try_lock() {
                if controls.0 != route {
                    return Ok(());
                }
                if version != Some(controls.2) {
                    engine.configure(&controls.1);
                    show_stereo = controls
                        .1
                        .effects
                        .iter()
                        .any(|effect| effect.enabled && effect.kind == EffectKind::Spectrogram);
                    show_scope = controls.1.effects.iter().any(|effect| {
                        matches!(
                            effect.kind,
                            EffectKind::StereoWidth | EffectKind::SpatialExpander
                        )
                    });
                    version = Some(controls.2);
                }
            }
            while capture.GetNextPacketSize()? > 0 {
                let mut data = ptr::null_mut();
                let mut count = 0;
                let mut flags = 0;
                capture.GetBuffer(&mut data, &mut count, &mut flags, None, None)?;
                if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
                    queue.clear();
                    primed = false;
                    phase = 0.;
                }
                let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null();
                for index in 0..count as usize {
                    let frame = if silent {
                        [0.; 2]
                    } else {
                        ptr::read_unaligned(data.cast::<Frame>().add(index))
                    };
                    if queue.len() == queue.capacity() {
                        queue.pop_front();
                    }
                    queue.push_back(frame);
                }
                capture.ReleaseBuffer(count)?;
                last_audio = Instant::now();
            }
            let available = output.capacity - output.client.GetCurrentPadding()?;
            if available > 0 {
                let buffer = render.GetBuffer(available)?.cast::<Frame>();
                let target = available.max(240) as usize;
                primed |= queue.len() >= target + 2;
                let error = queue.len() as f64 - (target + target / 2) as f64;
                ratio += ((1. + (error * 0.000003).clamp(-0.004, 0.004)) - ratio) * 0.025;
                for index in 0..available as usize {
                    let frame = if primed && queue.len() > 1 {
                        let a = queue[0];
                        let b = queue[1];
                        let frame = std::array::from_fn(|channel| {
                            a[channel] + (b[channel] - a[channel]) * phase as f32
                        });
                        phase += ratio;
                        while phase >= 1. && queue.len() > 1 {
                            phase -= 1.;
                            queue.pop_front();
                        }
                        frame
                    } else {
                        phase = 0.;
                        primed = false;
                        [0.; 2]
                    };
                    let processed = engine.process(frame);
                    analyzer.push(processed);
                    ptr::write_unaligned(buffer.add(index), processed);
                }
                render.ReleaseBuffer(available, 0)?;
            }
            if last_meter.elapsed() >= Duration::from_millis(55) {
                let meter = analyzer.snapshot(
                    engine.applied_bass(),
                    engine.compression(),
                    last_audio.elapsed() < Duration::from_millis(600),
                    show_stereo,
                    show_scope,
                );
                if let Ok(mut current) = audio.meter.try_lock() {
                    *current = meter;
                }
                last_meter = Instant::now();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_fft_separates_channels_without_changing_the_eq_spectrum() {
        let mut analyzer = Analyzer {
            samples: [[0.; 2]; FFT],
            next: 0,
            peak: [0.; 2],
        };
        for sample in 0..FFT {
            analyzer.push(
                [1000., 6000.]
                    .map(|hz| (std::f64::consts::TAU * hz * sample as f64 / RATE).sin() as f32),
            );
        }
        let (combined, stereo) = analyzer.spectra(true);
        let [left, right] = stereo.unwrap();
        let peak = |bins: &[f32]| {
            bins.iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .unwrap()
                .0
        };
        assert!(left[peak(&left)] - right[peak(&left)] > 40.);
        assert!(right[peak(&right)] - left[peak(&right)] > 40.);
        let (mono, _) = analyzer.spectra(false);
        assert!(mono.iter().zip(combined).all(|(a, b)| (a - b).abs() < 0.05));
    }
}
