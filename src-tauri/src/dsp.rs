use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, f64::consts::PI};

pub const RATE: f64 = 48_000.0;
pub const BANDS: usize = 16;
pub const EFFECTS: usize = 12;
pub const LOOKAHEAD: usize = 240;
const CEILING: f32 = 0.8912509;
const MAX_BASS: f32 = 36.0;
const BASS_REFERENCE: f32 = 12.0;
const PEAK_TAPS: usize = 16;
pub type Frame = [f32; 2];

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Shape {
    Bell,
    LowShelf,
    HighShelf,
    LowCut,
    HighCut,
    Notch,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Band {
    pub id: u32,
    pub shape: Shape,
    pub hz: f64,
    pub gain: f64,
    pub q: f64,
    pub enabled: bool,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EffectKind {
    Gain,
    Compressor,
    LowCut,
    HighCut,
    Saturation,
    StereoWidth,
    SpatialExpander,
    Spectrogram,
    Tremolo,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Effect {
    pub id: u32,
    pub kind: EffectKind,
    pub amount: f32,
    pub enabled: bool,
    #[serde(default)]
    pub compressor: Compressor,
    #[serde(default)]
    pub saturation: Saturation,
    #[serde(default)]
    pub spatial: Spatial,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Spatial {
    pub bass_hz: f32,
    pub ambience: f32,
}

impl Default for Spatial {
    fn default() -> Self {
        Self {
            bass_hz: 150.,
            ambience: 25.,
        }
    }
}

#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SaturationMode {
    #[default]
    Soft,
    Tube,
    Hard,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Saturation {
    pub mode: SaturationMode,
    pub mix: f32,
}
impl Default for Saturation {
    fn default() -> Self {
        Self {
            mode: SaturationMode::Soft,
            mix: 100.,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Compressor {
    pub ratio: f32,
    pub attack: f32,
    pub release: f32,
    pub knee: f32,
    pub makeup: f32,
    pub mix: f32,
    pub rms: bool,
    pub auto_makeup: bool,
}

impl Default for Compressor {
    fn default() -> Self {
        Self {
            ratio: 4.,
            attack: 4.,
            release: 104.,
            knee: 0.,
            makeup: 0.,
            mix: 100.,
            rms: false,
            auto_makeup: true,
        }
    }
}

impl Compressor {
    fn validate(self) -> bool {
        (1.0..=20.0).contains(&self.ratio)
            && (0.1..=100.0).contains(&self.attack)
            && (10.0..=1000.0).contains(&self.release)
            && (0.0..=24.0).contains(&self.knee)
            && (-12.0..=24.0).contains(&self.makeup)
            && (0.0..=100.0).contains(&self.mix)
    }
}
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub disable_bass_protection: bool,
    pub tone: Tone,
    pub bands: Vec<Band>,
    pub bass: f32,
    pub treble: f32,
    pub gain: f32,
    pub pre_gain: f32,
    pub pan: f32,
    pub effects: Vec<Effect>,
    pub bypass: bool,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Tone {
    pub bass_hz: f64,
    pub bass_q: f64,
    pub treble_hz: f64,
    pub treble_q: f64,
}
impl Default for Tone {
    fn default() -> Self {
        Self {
            bass_hz: 110.,
            bass_q: 0.707,
            treble_hz: 4500.,
            treble_q: 0.707,
        }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if !(0.0..=MAX_BASS).contains(&self.bass)
            || !(20.0..=1000.0).contains(&self.tone.bass_hz)
            || !(1000.0..=16000.0).contains(&self.tone.treble_hz)
            || !(0.25..=2.0).contains(&self.tone.bass_q)
            || !(0.25..=2.0).contains(&self.tone.treble_q)
            || !(-12.0..=12.0).contains(&self.treble)
            || !(-24.0..=24.0).contains(&self.gain)
            || !(-24.0..=24.0).contains(&self.pre_gain)
            || !(-100.0..=100.0).contains(&self.pan)
            || self.bands.len() > BANDS
            || self.effects.len() > EFFECTS
            || self.bands.iter().enumerate().any(|(i, band)| {
                !(20.0..=20_000.0).contains(&band.hz)
                    || !(-36.0..=36.0).contains(&band.gain)
                    || !(0.25..=12.0).contains(&band.q)
                    || self.bands[..i].iter().any(|other| other.id == band.id)
            })
            || self.effects.iter().enumerate().any(|(i, effect)| {
                let range = match effect.kind {
                    EffectKind::Gain => -24.0..=12.0,
                    EffectKind::Compressor => -48.0..=0.0,
                    EffectKind::LowCut | EffectKind::HighCut => 20.0..=20_000.0,
                    EffectKind::Saturation => 0.0..=24.0,
                    EffectKind::StereoWidth => 0.0..=200.0,
                    EffectKind::SpatialExpander => 0.0..=100.0,
                    EffectKind::Spectrogram => 0.0..=0.0,
                    EffectKind::Tremolo => 0.1..=20.0,
                };
                !range.contains(&effect.amount)
                    || !effect.compressor.validate()
                    || !(0.0..=100.0).contains(&effect.saturation.mix)
                    || !(60.0..=400.0).contains(&effect.spatial.bass_hz)
                    || !(0.0..=100.0).contains(&effect.spatial.ambience)
                    || self.effects[..i].iter().any(|other| other.id == effect.id)
            })
        {
            return Err("One or more controls are out of range.".into());
        }
        Ok(())
    }
}

const FLAT: [f64; 5] = [1., 0., 0., 0., 0.];

fn coefficients(band: Band) -> [f64; 5] {
    let w = 2.0 * PI * band.hz / RATE;
    let (s, c) = w.sin_cos();
    let alpha = s / (2.0 * band.q);
    let a = 10f64.powf(band.gain / 40.0);
    let [b0, b1, b2, a0, a1, a2] = match band.shape {
        Shape::Bell => [
            1. + alpha * a,
            -2. * c,
            1. - alpha * a,
            1. + alpha / a,
            -2. * c,
            1. - alpha / a,
        ],
        Shape::LowCut => [
            (1. + c) / 2.,
            -(1. + c),
            (1. + c) / 2.,
            1. + alpha,
            -2. * c,
            1. - alpha,
        ],
        Shape::HighCut => [
            (1. - c) / 2.,
            1. - c,
            (1. - c) / 2.,
            1. + alpha,
            -2. * c,
            1. - alpha,
        ],
        Shape::Notch => [1., -2. * c, 1., 1. + alpha, -2. * c, 1. - alpha],
        Shape::LowShelf | Shape::HighShelf => {
            let plus = a + 1.;
            let minus = a - 1.;
            let edge = 2.0 * a.sqrt() * alpha;
            if band.shape == Shape::LowShelf {
                [
                    a * (plus - minus * c + edge),
                    2. * a * (minus - plus * c),
                    a * (plus - minus * c - edge),
                    plus + minus * c + edge,
                    -2. * (minus + plus * c),
                    plus + minus * c - edge,
                ]
            } else {
                [
                    a * (plus + minus * c + edge),
                    -2. * a * (minus + plus * c),
                    a * (plus + minus * c - edge),
                    plus - minus * c + edge,
                    2. * (minus - plus * c),
                    plus - minus * c - edge,
                ]
            }
        }
    };
    [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
}

#[derive(Clone, Copy)]
struct Filter {
    id: Option<u32>,
    current: [f64; 5],
    target: [f64; 5],
    memory: [[f64; 2]; 2],
}

impl Default for Filter {
    fn default() -> Self {
        Self {
            id: None,
            current: FLAT,
            target: FLAT,
            memory: [[0.; 2]; 2],
        }
    }
}

impl Filter {
    fn process(&mut self, mut frame: Frame) -> Frame {
        for (current, target) in self.current.iter_mut().zip(self.target) {
            *current += (target - *current) * 0.004;
        }
        let [b0, b1, b2, a1, a2] = self.current;
        for (sample, [z1, z2]) in frame.iter_mut().zip(&mut self.memory) {
            let input = *sample as f64;
            let output = b0 * input + *z1;
            *z1 = b1 * input - a1 * output + *z2;
            *z2 = b2 * input - a2 * output;
            *sample = output as f32;
        }
        frame
    }
}

fn peak(frame: Frame) -> f32 {
    frame[0].abs().max(frame[1].abs())
}
fn amplitude(db: f32) -> f32 {
    10f32.powf(db / 20.)
}

struct Limiter {
    frames: [Frame; LOOKAHEAD],
    pos: usize,
    history: [Frame; PEAK_TAPS],
    kernels: [[f32; PEAK_TAPS]; 3],
    maxima: VecDeque<(u64, f32)>,
    sample_index: u64,
    gain: f32,
}

impl Limiter {
    fn new() -> Self {
        let kernels = std::array::from_fn(|phase| {
            let mut taps = std::array::from_fn(|tap| {
                let distance = tap as f64 - 7.0 - (phase + 1) as f64 * 0.25;
                let angle = PI * distance;
                let window = 0.42 + 0.5 * (angle / 8.).cos() + 0.08 * (angle / 4.).cos();
                (angle.sin() / angle * window) as f32
            });
            let total: f32 = taps.iter().sum();
            taps.iter_mut().for_each(|tap| *tap /= total);
            taps
        });
        Self {
            frames: [[0.; 2]; LOOKAHEAD],
            pos: 0,
            history: [[0.; 2]; PEAK_TAPS],
            kernels,
            maxima: VecDeque::with_capacity(LOOKAHEAD + PEAK_TAPS + 2),
            sample_index: 0,
            gain: 1.,
        }
    }

    fn process(&mut self, frame: Frame) -> Frame {
        self.history.rotate_left(1);
        self.history[PEAK_TAPS - 1] = frame;
        let mut estimate = peak(frame);
        for kernel in &self.kernels {
            let mut interpolated = [0.; 2];
            for (sample, tap) in self.history.iter().zip(kernel) {
                interpolated[0] += sample[0] * tap;
                interpolated[1] += sample[1] * tap;
            }
            estimate = estimate.max(peak(interpolated));
        }
        // Retain extrema until their corresponding source samples leave the look-ahead.
        let oldest = self
            .sample_index
            .saturating_sub((LOOKAHEAD + PEAK_TAPS) as u64);
        while self
            .maxima
            .front()
            .is_some_and(|(index, _)| *index < oldest)
        {
            self.maxima.pop_front();
        }
        while self
            .maxima
            .back()
            .is_some_and(|(_, previous)| *previous <= estimate)
        {
            self.maxima.pop_back();
        }
        self.maxima.push_back((self.sample_index, estimate));
        self.sample_index += 1;
        let (_, maximum) = self.maxima[0];
        let required = (CEILING * 0.98 / maximum.max(f32::MIN_POSITIVE)).min(1.);
        self.gain = (self.gain + (1. - self.gain) * 0.00035).min(required);
        let delayed = std::mem::replace(&mut self.frames[self.pos], frame);
        self.pos = (self.pos + 1) % LOOKAHEAD;
        delayed.map(|sample| sample * self.gain)
    }
}

#[derive(Clone, Copy, Default)]
struct SpatialProcessor {
    amount: f32,
    amount_target: f32,
    crossover: f32,
    crossover_target: f32,
    ambience: f32,
    ambience_target: f32,
    low: Frame,
    phase: [[f32; 3]; 2],
}

impl SpatialProcessor {
    fn configure(&mut self, amount: f32, settings: Spatial) {
        self.amount_target = amount / 100.;
        self.crossover_target =
            1. - (-std::f32::consts::TAU * settings.bass_hz / RATE as f32).exp();
        self.ambience_target = settings.ambience / 100.;
    }

    fn process(&mut self, frame: Frame) -> Frame {
        self.amount += (self.amount_target - self.amount) * 0.004;
        self.crossover += (self.crossover_target - self.crossover) * 0.004;
        self.ambience += (self.ambience_target - self.ambience) * 0.004;
        let mid = (frame[0] + frame[1]) * 0.5;
        let side = (frame[0] - frame[1]) * 0.5;
        self.low[0] += (mid - self.low[0]) * self.crossover;
        self.low[1] += (side - self.low[1]) * self.crossover;
        let high_mid = mid - self.low[0];
        let high_side = side - self.low[1];

        // Staggered all-pass sections add a phase-different signal to the sides.
        // The opposite polarities preserve the original mono sum.
        const PHASE: [[f32; 3]; 2] = [[-0.94, -0.80, -0.47], [-0.88, -0.67, -0.20]];
        let paths: Frame = std::array::from_fn(|channel| {
            let mut sample = high_mid;
            for (coefficient, state) in PHASE[channel].into_iter().zip(&mut self.phase[channel]) {
                let output = coefficient * sample + *state;
                *state = sample - coefficient * output;
                sample = output;
            }
            sample
        });
        let diffuse = (paths[0] - paths[1]) * 0.18 * self.ambience;
        let wide = side + self.amount * (0.85 * high_side - self.low[1] + diffuse);
        [mid + wide, mid - wide]
    }
}

#[derive(Clone, Copy, Default)]
struct Insert {
    phase: f32,
    spatial: SpatialProcessor,
    saturation: Saturation,
    id: Option<u32>,
    kind: Option<EffectKind>,
    gain: f32,
    threshold: f32,
    mix: f32,
    enabled: bool,
    envelope: f32,
    compressor: Compressor,
    attack: f32,
    release: f32,
    makeup: f32,
    drive: f32,
    reduction: f32,
    filter: Filter,
}

pub struct Engine {
    bands: [Filter; BANDS],
    shelf: Filter,
    bass: f32,
    bass_mix: f32,
    bass_reference: f32,
    protect_bass: bool,
    treble: Filter,
    mix_target: Frame,
    pre_target: f32,
    pre_gain: f32,
    mix_gain: Frame,
    inserts: [Insert; EFFECTS],
    bypass: bool,
    wet: f32,
    limiter: Limiter,
}

impl Engine {
    pub fn new() -> Self {
        let shelf = coefficients(Band {
            id: 0,
            shape: Shape::LowShelf,
            hz: 110.,
            gain: BASS_REFERENCE.into(),
            q: 0.707,
            enabled: true,
        });
        Self {
            bands: [Filter::default(); BANDS],
            shelf: Filter {
                current: shelf,
                target: shelf,
                ..Filter::default()
            },
            bass: 0.,
            bass_mix: 0.,
            bass_reference: BASS_REFERENCE,
            protect_bass: true,
            treble: Filter::default(),
            mix_target: [1.; 2],
            pre_target: 1.,
            pre_gain: 1.,
            mix_gain: [1.; 2],
            inserts: [Insert::default(); EFFECTS],
            bypass: false,
            wet: 1.,
            limiter: Limiter::new(),
        }
    }

    pub fn configure(&mut self, settings: &Settings) {
        let previous = self.bands;
        self.bands = [Filter::default(); BANDS];
        for (filter, band) in self.bands.iter_mut().zip(&settings.bands) {
            *filter = previous
                .iter()
                .find(|old| old.id == Some(band.id))
                .copied()
                .unwrap_or_default();
            filter.id = Some(band.id);
            filter.target = if band.enabled {
                coefficients(*band)
            } else {
                FLAT
            };
        }
        let reference = settings.bass.max(BASS_REFERENCE);
        self.bass_mix *= (amplitude(self.bass_reference) - 1.) / (amplitude(reference) - 1.);
        self.bass_reference = reference;
        self.protect_bass = !settings.disable_bass_protection;
        self.bass = (amplitude(settings.bass) - 1.) / (amplitude(reference) - 1.);
        self.treble.target = coefficients(treble_band(settings.treble, settings.tone));
        self.shelf.target = coefficients(Band {
            id: 0,
            shape: Shape::LowShelf,
            hz: settings.tone.bass_hz,
            gain: reference.into(),
            q: settings.tone.bass_q,
            enabled: true,
        });
        let gain = amplitude(settings.gain);
        self.pre_target = amplitude(settings.pre_gain);
        let pan = settings.pan / 100.;
        self.mix_target = [gain * (1. - pan.max(0.)), gain * (1. + pan.min(0.))];
        self.bypass = settings.bypass;
        let previous = self.inserts;
        self.inserts = [Insert::default(); EFFECTS];
        for (insert, effect) in self.inserts.iter_mut().zip(&settings.effects) {
            *insert = previous
                .iter()
                .find(|old| old.id == Some(effect.id))
                .copied()
                .unwrap_or_default();
            insert.id = Some(effect.id);
            insert.kind = Some(effect.kind);
            insert.enabled = effect.enabled;
            insert.threshold = effect.amount;
            insert.saturation = effect.saturation;
            if effect.kind == EffectKind::SpatialExpander {
                insert.spatial.configure(effect.amount, effect.spatial);
            }
            insert.drive = if matches!(effect.kind, EffectKind::Gain | EffectKind::Saturation) {
                amplitude(effect.amount)
            } else {
                1.
            };
            insert.compressor = effect.compressor;
            let time_coefficient = |ms: f32| 1. - (-1000. / (RATE as f32 * ms)).exp();
            insert.attack = time_coefficient(effect.compressor.attack);
            insert.release = time_coefficient(effect.compressor.release);
            let auto = if effect.compressor.auto_makeup {
                (-effect.amount * (1. - effect.compressor.ratio.recip()) * 0.5).clamp(0., 12.)
            } else {
                0.
            };
            insert.makeup = amplitude(effect.compressor.makeup + auto);
            match effect.kind {
                EffectKind::LowCut | EffectKind::HighCut => {
                    insert.filter.target = coefficients(Band {
                        id: effect.id,
                        shape: if effect.kind == EffectKind::LowCut {
                            Shape::LowCut
                        } else {
                            Shape::HighCut
                        },
                        hz: effect.amount.into(),
                        gain: 0.,
                        q: 0.707,
                        enabled: true,
                    })
                }
                _ => insert.filter.target = FLAT,
            }
        }
    }

    pub fn applied_bass(&self) -> f32 {
        20. * (1. + self.bass_mix * (amplitude(self.bass_reference) - 1.)).log10()
    }

    pub fn compression(&self) -> Vec<(u32, f32)> {
        self.inserts
            .iter()
            .filter(|insert| insert.kind == Some(EffectKind::Compressor))
            .filter_map(|insert| {
                insert.id.map(|id| {
                    (
                        id,
                        if self.bypass {
                            0.
                        } else {
                            insert.reduction * insert.mix
                        },
                    )
                })
            })
            .collect()
    }

    pub fn process(&mut self, input: Frame) -> Frame {
        let input = input.map(|sample| if sample.is_finite() { sample } else { 0. });
        self.pre_gain += (self.pre_target - self.pre_gain) * 0.004;
        let mut frame = input.map(|sample| sample * self.pre_gain);
        for filter in self.bands.iter_mut().filter(|filter| filter.id.is_some()) {
            frame = filter.process(frame);
        }
        frame = self.treble.process(frame);
        let shelf = self.shelf.process(frame);
        let delta = [shelf[0] - frame[0], shelf[1] - frame[1]];
        let mut allowed = self.bass;
        for (sample, boost) in frame.into_iter().zip(delta) {
            if self.protect_bass && boost.abs() > 1e-7 {
                allowed =
                    allowed.min(((CEILING * 0.98 - sample * boost.signum()) / boost.abs()).max(0.));
            }
        }
        self.bass_mix = allowed.min(self.bass_mix + (allowed - self.bass_mix) * 0.0003);
        for (sample, boost) in frame.iter_mut().zip(delta) {
            *sample += boost * self.bass_mix;
        }
        for insert in self.inserts.iter_mut().filter(|insert| insert.id.is_some()) {
            insert.mix += (f32::from(insert.enabled) - insert.mix) * 0.004;
            let wet = match insert.kind {
                Some(EffectKind::Gain) => {
                    insert.gain += (insert.drive - insert.gain) * 0.004;
                    frame.map(|sample| sample * insert.gain)
                }
                Some(EffectKind::Compressor) => {
                    let rms = insert.compressor.rms;
                    let level = if rms {
                        (frame[0].powi(2) + frame[1].powi(2)) * 0.5
                    } else {
                        peak(frame)
                    };
                    let speed = if level > insert.envelope {
                        insert.attack
                    } else {
                        insert.release
                    };
                    insert.envelope += (level - insert.envelope) * speed;
                    let db = if rms { 10. } else { 20. } * insert.envelope.max(1e-12).log10();
                    let over = db - insert.threshold;
                    let half = insert.compressor.knee * 0.5;
                    let compressed = if half > 0. && over.abs() < half {
                        (over + half).powi(2) / (4. * half)
                    } else {
                        over.max(0.)
                    };
                    insert.reduction = compressed * (1. - insert.compressor.ratio.recip());
                    let gain = amplitude(-insert.reduction) * insert.makeup;
                    insert.gain += (gain - insert.gain) * 0.004;
                    let mix = insert.compressor.mix / 100.;
                    frame.map(|sample| sample * (1. + (insert.gain - 1.) * mix))
                }
                Some(EffectKind::Saturation) => {
                    insert.gain += (insert.drive - insert.gain) * 0.004;
                    frame.map(|sample| {
                        let driven = sample * insert.gain;
                        let shaped = match insert.saturation.mode {
                            SaturationMode::Soft => driven / (1. + driven * driven).sqrt(),
                            SaturationMode::Tube => driven.tanh(),
                            SaturationMode::Hard => driven.clamp(-1., 1.),
                        };
                        sample + (shaped - sample) * insert.saturation.mix / 100.
                    })
                }
                Some(EffectKind::LowCut | EffectKind::HighCut) => insert.filter.process(frame),
                Some(EffectKind::StereoWidth) => {
                    insert.gain += (insert.threshold / 100. - insert.gain) * 0.004;
                    let mid = (frame[0] + frame[1]) * 0.5;
                    let side = (frame[0] - frame[1]) * 0.5 * insert.gain;
                    [mid + side, mid - side]
                }
                Some(EffectKind::SpatialExpander) => insert.spatial.process(frame),
                Some(EffectKind::Tremolo) => {
                    insert.phase = (insert.phase + insert.threshold / RATE as f32).fract();
                    let level = 0.75 + 0.25 * (std::f32::consts::TAU * insert.phase).cos();
                    frame.map(|sample| sample * level)
                }
                Some(EffectKind::Spectrogram) | None => frame,
            };
            frame = std::array::from_fn(|channel| {
                frame[channel] + (wet[channel] - frame[channel]) * insert.mix
            });
        }
        self.wet += (f32::from(!self.bypass) - self.wet) * 0.004;
        for ((sample, current), target) in frame
            .iter_mut()
            .zip(&mut self.mix_gain)
            .zip(self.mix_target)
        {
            *current += (target - *current) * 0.004;
            *sample *= *current;
        }
        self.limiter.process(std::array::from_fn(|channel| {
            input[channel] + (frame[channel] - input[channel]) * self.wet
        }))
    }
}

fn treble_band(gain: f32, tone: Tone) -> Band {
    Band {
        id: 0,
        shape: Shape::HighShelf,
        hz: tone.treble_hz,
        gain: gain.into(),
        q: tone.treble_q,
        enabled: true,
    }
}

pub fn response(settings: &Settings) -> Vec<(i64, Vec<f64>)> {
    let reference = settings.bass.max(BASS_REFERENCE);
    let bass = coefficients(Band {
        id: 0,
        shape: Shape::LowShelf,
        hz: settings.tone.bass_hz,
        gain: reference.into(),
        q: settings.tone.bass_q,
        enabled: true,
    });
    let blend = f64::from((amplitude(settings.bass) - 1.) / (amplitude(reference) - 1.));
    let dry = [1., bass[3], bass[4]];
    let bass_response = [
        dry[0] + (bass[0] - dry[0]) * blend,
        dry[1] + (bass[1] - dry[1]) * blend,
        dry[2] + (bass[2] - dry[2]) * blend,
        bass[3],
        bass[4],
    ];
    settings
        .bands
        .iter()
        .filter(|band| band.enabled)
        .map(|band| (i64::from(band.id), coefficients(*band)))
        .chain((settings.bass != 0.).then_some((-1, bass_response)))
        .chain((settings.treble != 0.).then(|| {
            (
                -2,
                coefficients(treble_band(settings.treble, settings.tone)),
            )
        }))
        .map(|(id, [b0, b1, b2, a1, a2])| {
            let curve = (0..=480)
                .map(|index| {
                    let w = 2. * PI * (20. * 1000f64.powf(index as f64 / 480.)) / RATE;
                    let (s, c) = w.sin_cos();
                    let (s2, c2) = (2. * w).sin_cos();
                    let num = (b0 + b1 * c + b2 * c2).hypot(b1 * s + b2 * s2);
                    let den = (1. + a1 * c + a2 * c2).hypot(a1 * s + a2 * s2);
                    20. * (num / den).max(1e-8).log10()
                })
                .collect();
            (id, curve)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spatial_expander_reduces_low_side_and_widens_high_side() {
        let side_gain = |hz: f64| {
            let mut expander = SpatialProcessor::default();
            expander.configure(100., Spatial::default());
            let mut energy = 0.0;
            let mut input = 0.0;
            for i in 0..48000 {
                let sample = (2. * PI * i as f64 * hz / RATE).sin() as f32 * 0.1;
                let [left, right] = expander.process([sample, -sample]);
                if i >= 24000 {
                    energy += ((left - right) * 0.5).powi(2);
                    input += sample.powi(2);
                }
            }
            (energy / input).sqrt()
        };
        assert!(side_gain(15.) < 0.25);
        assert!(side_gain(3000.) > 1.7);
    }

    #[test]
    fn spatial_ambience_preserves_the_mono_sum() {
        let mut expander = SpatialProcessor::default();
        expander.configure(
            100.,
            Spatial {
                ambience: 100.,
                ..Spatial::default()
            },
        );
        let mut difference = 0.0f32;
        for i in 0..4000 {
            let input = (2. * PI * i as f64 * 1100. / RATE).sin() as f32 * 0.1;
            let [left, right] = expander.process([input; 2]);
            assert!(((left + right) * 0.5 - input).abs() < 1e-6);
            difference = difference.max((left - right).abs());
        }
        assert!(difference > 0.01);
    }

    #[test]
    fn tone_overlays_follow_the_shelves() {
        let curves = response(&Settings {
            bass: 6.,
            treble: -5.,
            ..Settings::default()
        });
        assert_eq!(curves[0].0, -1);
        assert!((curves[0].1[0] - 6.).abs() < 0.2);
        assert!(curves[0].1[480].abs() < 0.01);
        assert_eq!(curves[1].0, -2);
        assert!((curves[1].1[480] + 5.).abs() < 0.1);
    }

    fn rms(engine: &mut Engine, hz: f64, amplitude: f32) -> f32 {
        let samples = RATE as usize;
        let mut squares = 0.;
        for index in 0..samples {
            let sample = (2. * PI * hz * index as f64 / RATE).sin() as f32 * amplitude;
            let output = engine.process([sample; 2]);
            if index >= samples / 2 {
                squares += output[0] * output[0];
            }
        }
        (squares / (samples / 2) as f32).sqrt()
    }

    #[test]
    fn mixer_changes_channel_balance_and_gain() {
        let mut engine = Engine::new();
        engine.configure(&Settings {
            gain: 6.,
            pan: 100.,
            ..Settings::default()
        });
        let output = (0..8000).fold([0.; 2], |_, _| engine.process([0.1; 2]));
        assert!(output[0].abs() < 1e-5);
        assert!((output[1] - 0.1 * amplitude(6.)).abs() < 1e-5);
    }

    #[test]
    fn legacy_compressor_recovers_level_with_makeup() {
        let mut effect: Effect =
            serde_json::from_str(r#"{"id":1,"kind":"compressor","amount":-18,"enabled":true}"#)
                .unwrap();
        let mut with_makeup = Engine::new();
        with_makeup.configure(&Settings {
            effects: vec![effect],
            ..Settings::default()
        });
        effect.compressor.auto_makeup = false;
        let mut without_makeup = Engine::new();
        without_makeup.configure(&Settings {
            effects: vec![effect],
            ..Settings::default()
        });
        let after = rms(&mut with_makeup, 200., 0.5);
        let before = rms(&mut without_makeup, 200., 0.5);
        assert!((6.6..6.9).contains(&(20. * (after / before).log10())));
        assert!(with_makeup.compression()[0].1 > 0.);
    }

    #[test]
    fn treble_changes_high_frequencies_and_appears_in_the_response() {
        let settings = Settings {
            treble: 6.,
            ..Settings::default()
        };
        let mut engine = Engine::new();
        engine.configure(&settings);
        let low = rms(&mut engine, 100., 0.1);
        let high = rms(&mut engine, 15_000., 0.1);
        assert!((low - 0.1 / 2f32.sqrt()).abs() < 0.0001);
        assert!(20. * (high / low).log10() > 5.);
        assert!(response(&settings)[0].1[480] > 5.);
    }

    #[test]
    fn bass_uses_headroom_and_leaves_high_frequencies_at_unity() {
        let mut engine = Engine::new();
        let base = rms(&mut engine, 25., 0.1);
        engine.configure(&Settings {
            bass: 6.,
            ..Settings::default()
        });
        let boosted = rms(&mut engine, 25., 0.1);
        assert!((5.8..6.2).contains(&(20. * (boosted / base).log10())));
        let high = rms(&mut engine, 4000., 0.1);
        assert!((high - base).abs() < 0.0002);
        let loud = rms(&mut engine, 25., 0.84);
        assert!(loud < 0.67);
        assert!(engine.applied_bass() < 2.);
    }

    #[test]
    fn limiter_controls_high_frequency_intersample_peaks() {
        let mut engine = Engine::new();
        let measured = rms(&mut engine, 12_000., 1.2);
        // The quadrature sample train has an ideal interpolated peak of sqrt(2) × RMS.
        assert!(measured * 2f32.sqrt() < CEILING);
        // Repeat with the quarter-cycle samples offset by 45°, which hides the peaks.
        let mut peak_sample = 0f32;
        for index in 0..6000 {
            let input = (PI * 0.5 * index as f64 + PI * 0.25).sin() as f32;
            let out = engine.process([input; 2]);
            if index > 3000 {
                peak_sample = peak_sample.max(out[0].abs());
            }
        }
        assert!(peak_sample * 2f32.sqrt() < CEILING);
    }

    #[test]
    fn reported_bell_matches_measured_center_gain() {
        let settings = Settings {
            bands: vec![Band {
                id: 1,
                shape: Shape::Bell,
                hz: 20. * 1000f64.powf(0.5),
                gain: 5.,
                q: 1.,
                enabled: true,
            }],
            ..Settings::default()
        };
        let mut engine = Engine::new();
        engine.configure(&settings);
        let measured = rms(&mut engine, settings.bands[0].hz, 0.1);
        let measured_db = 20. * (measured * 2f32.sqrt() / 0.1).log10();
        assert!((response(&settings)[0].1[240] - f64::from(measured_db)).abs() < 0.02);
    }
}
