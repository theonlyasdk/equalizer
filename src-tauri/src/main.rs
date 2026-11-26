#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod dsp;

use audio::{Audio, Device, Meter, Route};
use dsp::Settings;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State, WindowEvent};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
struct Library {
    input: String,
    output: String,
    settings: Settings,
    presets: BTreeMap<String, Settings>,
    device_presets: BTreeMap<String, String>,
    restore: Option<PlaybackRestore>,
    suspended: bool,
    quit_on_close: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct PlaybackRestore {
    virtual_endpoint: String,
    defaults: [String; 2],
}

impl Library {
    fn route(&self) -> Route {
        Route {
            input: if self.suspended {
                String::new()
            } else {
                self.input.clone()
            },
            output: self.output.clone(),
        }
    }
}

struct App {
    audio: Arc<Audio>,
    library: Mutex<Library>,
    file: PathBuf,
    routing: Mutex<()>,
    keep_in_tray_item: Mutex<Option<tauri::menu::CheckMenuItem<tauri::Wry>>>,
}

const STARTUP_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const STARTUP_VALUE: &str = "Equalizer";

fn startup_enabled() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("reg")
        .args(["query", STARTUP_KEY, "/v", STARTUP_VALUE])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn set_startup(enabled: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = if enabled {
        let exe = std::env::current_exe().map_err(error)?;
        let value = format!("\"{}\"", exe.display());
        std::process::Command::new("reg")
            .args([
                "add",
                STARTUP_KEY,
                "/v",
                STARTUP_VALUE,
                "/t",
                "REG_SZ",
                "/d",
                &value,
                "/f",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(error)?
    } else {
        std::process::Command::new("reg")
            .args(["delete", STARTUP_KEY, "/v", STARTUP_VALUE, "/f"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(error)?
    };
    if status.success() {
        Ok(())
    } else {
        Err("Could not update Windows startup setting.".into())
    }
}

impl App {
    fn update(&self, edit: impl FnOnce(&mut Library)) -> Result<Library, String> {
        let mut current = self.library.lock().map_err(error)?;
        let mut next = current.clone();
        edit(&mut next);
        let temporary = self.file.with_extension("tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(&next).map_err(error)?).map_err(error)?;
        fs::rename(temporary, &self.file).map_err(error)?;
        let mut audio = self.audio.controls.lock().map_err(error)?;
        audio.0 = next.route();
        audio.1 = next.settings.clone();
        audio.2 = audio.2.wrapping_add(1);
        *current = next.clone();
        Ok(next)
    }
}

fn error(message: impl std::fmt::Display) -> String {
    message.to_string()
}

#[tauri::command]
fn library(app: State<App>) -> Result<Library, String> {
    Ok(app.library.lock().map_err(error)?.clone())
}

#[tauri::command]
async fn devices() -> Result<(Vec<Device>, String), String> {
    tauri::async_runtime::spawn_blocking(|| audio::devices().map_err(error))
        .await
        .map_err(error)?
}

#[tauri::command]
fn meter(app: State<App>) -> Result<Meter, String> {
    Ok(app.audio.meter.lock().map_err(error)?.clone())
}

#[tauri::command]
fn route(app: State<App>, input: String, output: String) -> Result<Library, String> {
    if !input.is_empty() && input == output {
        return Err("Input and output must be different devices.".into());
    }
    app.update(|data| {
        if !input.is_empty() && input != data.input {
            data.suspended = false;
        }
        apply_route(data, input, output);
    })
}

fn apply_route(data: &mut Library, input: String, output: String) {
    if data.output != output {
        if let Some(preset) = data
            .device_presets
            .get(&output)
            .and_then(|name| data.presets.get(name))
        {
            data.settings = preset.clone();
        }
    }
    data.input = input;
    data.output = output;
}

fn is_virtual(device: &Device) -> bool {
    let name = device.name.to_ascii_lowercase();
    name.starts_with("cable input")
        || name.contains("vb-audio virtual cable")
        || name.contains("virtual audio driver by mtt")
}

fn activate_routing(app: &App) -> Result<Option<Library>, String> {
    let _routing = app
        .routing
        .try_lock()
        .map_err(|_| "Audio setup is already running.")?;
    let previous = app.library.lock().map_err(error)?.clone();
    let (devices, default) = audio::devices().map_err(error)?;
    let Some(input) = devices
        .iter()
        .filter(|device| is_virtual(device))
        .min_by_key(|device| (device.id != previous.input, device.id != default))
    else {
        return Ok(None);
    };
    let output = devices
        .iter()
        .filter(|device| !is_virtual(device))
        .min_by_key(|device| (device.id != previous.output, device.id != default))
        .ok_or_else(|| "Connect speakers or headphones, then try again.".to_string())?;
    audio::check_route(&input.id, &output.id)
        .map_err(|reason| format!("Could not open the audio route. {reason}"))?;
    let defaults = audio::playback_defaults().map_err(error)?;
    let next = app.update(|data| {
        let saved = data
            .restore
            .as_ref()
            .filter(|restore| restore.virtual_endpoint == input.id);
        data.restore = Some(PlaybackRestore {
            virtual_endpoint: input.id.clone(),
            defaults: std::array::from_fn(|index| {
                if defaults[index] == input.id || defaults[index].is_empty() {
                    saved
                        .map(|old| old.defaults[index].clone())
                        .unwrap_or_else(|| output.id.clone())
                } else {
                    defaults[index].clone()
                }
            }),
        });
        apply_route(data, input.id.clone(), output.id.clone());
        data.suspended = false;
    })?;
    if let Err(reason) = audio::set_playback_defaults([&input.id; 2]) {
        app.update(|data| {
            data.input = previous.input;
            data.output = previous.output;
            data.settings = previous.settings;
            data.restore = previous.restore;
            data.suspended = previous.suspended;
        })?;
        return Err(format!(
            "Windows could not switch playback devices. {reason}"
        ));
    }
    Ok(Some(next))
}

#[tauri::command]
async fn auto_setup(handle: tauri::AppHandle) -> Result<Option<Library>, String> {
    tauri::async_runtime::spawn_blocking(move || activate_routing(&handle.state::<App>()))
        .await
        .map_err(error)?
}

fn restore_playback(
    app: &App,
    choice: Option<String>,
) -> Result<(Option<Library>, Vec<Device>, String), String> {
    let _routing = app
        .routing
        .try_lock()
        .map_err(|_| "Audio setup is still running.")?;
    let library = app.library.lock().map_err(error)?.clone();
    let current = audio::playback_defaults().map_err(error)?;
    let (devices, _) = audio::devices().map_err(error)?;
    let physical: Vec<_> = devices
        .iter()
        .filter(|device| !is_virtual(device) && device.id != library.input)
        .cloned()
        .collect();
    let connected = |id: &str| physical.iter().any(|device| device.id == id);
    if choice.as_deref().is_some_and(|id| !connected(id)) {
        return Err("That listening device is no longer available.".into());
    }
    let mut desired = current.clone();
    for (index, output) in desired.iter_mut().enumerate() {
        let from_virtual = library
            .restore
            .as_ref()
            .is_some_and(|saved| saved.virtual_endpoint == current[index])
            || devices
                .iter()
                .any(|device| device.id == current[index] && is_virtual(device))
            || (!library.input.is_empty()
                && !library.output.is_empty()
                && current[index] == library.input);
        if !from_virtual {
            continue;
        }
        let candidate = choice
            .as_deref()
            .or_else(|| {
                library
                    .restore
                    .as_ref()
                    .map(|saved| saved.defaults[index].as_str())
                    .filter(|id| connected(id))
            })
            .or_else(|| connected(&library.output).then_some(library.output.as_str()))
            .or_else(|| (physical.len() == 1).then(|| physical[0].id.as_str()));
        let Some(candidate) = candidate else {
            if physical.is_empty() {
                return Err("Connect speakers or headphones before turning Equalizer off.".into());
            }
            return Ok((None, physical, current[1].clone()));
        };
        *output = candidate.to_owned();
    }
    audio::set_playback_defaults([&desired[0], &desired[1]]).map_err(error)?;
    let next = app.update(|data| {
        data.restore = None;
        data.suspended = true;
    })?;
    Ok((Some(next), Vec::new(), desired[1].clone()))
}

#[tauri::command]
async fn disable_routing(
    handle: tauri::AppHandle,
    output: Option<String>,
) -> Result<(Option<Library>, Vec<Device>, String), String> {
    tauri::async_runtime::spawn_blocking(move || restore_playback(&handle.state::<App>(), output))
        .await
        .map_err(error)?
}

#[tauri::command]
fn set_close_behavior(app: State<App>, quit: bool) -> Result<(), String> {
    app.update(|data| data.quit_on_close = quit)?;
    if let Ok(guard) = app.keep_in_tray_item.lock() {
        if let Some(item) = guard.as_ref() {
            let _ = item.set_checked(!quit);
        }
    }
    Ok(())
}

#[tauri::command]
async fn speaker_volume(output: String, level: Option<f32>) -> Result<f32, String> {
    if level.is_some_and(|value| !(0.0..=100.0).contains(&value)) {
        return Err("Speaker volume must be between 0 and 100.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        audio::endpoint_volume(&output, level.map(|value| value / 100.))
            .map(|value| value * 100.)
            .map_err(error)
    })
    .await
    .map_err(error)?
}

#[tauri::command]
fn driver_website() -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg("https://vb-audio.com/Cable/")
        .spawn()
        .map_err(error)?;
    Ok(())
}

#[tauri::command]
fn update_settings(app: State<App>, settings: Settings) -> Result<(), String> {
    settings.validate()?;
    app.update(|data| data.settings = settings)?;
    Ok(())
}

#[tauri::command]
fn response(settings: Settings) -> Result<Vec<(i64, Vec<f64>)>, String> {
    settings.validate()?;
    Ok(dsp::response(&settings))
}

#[tauri::command]
fn preset(app: State<App>, name: String, save: Option<Settings>) -> Result<Library, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err("Enter a preset name of 1–64 characters.".into());
    }
    if let Some(settings) = save {
        settings.validate()?;
        app.update(|data| {
            data.presets.insert(name.into(), settings.clone());
            data.settings = settings;
            if !data.output.is_empty() {
                data.device_presets.insert(data.output.clone(), name.into());
            }
        })
    } else {
        let settings = app
            .library
            .lock()
            .map_err(error)?
            .presets
            .get(name)
            .cloned()
            .ok_or_else(|| "Preset unavailable.".to_string())?;
        app.update(|data| {
            data.settings = settings;
            if !data.output.is_empty() {
                data.device_presets.insert(data.output.clone(), name.into());
            }
        })
    }
}

#[tauri::command]
fn assign_device_preset(
    app: State<App>,
    device: String,
    preset: String,
) -> Result<Library, String> {
    if device.trim().is_empty() {
        return Err("Select an audio device.".into());
    }
    let name = preset.trim();
    if name.is_empty() {
        return app.update(|data| {
            data.device_presets.remove(&device);
        });
    }
    let settings = app
        .library
        .lock()
        .map_err(error)?
        .presets
        .get(name)
        .cloned()
        .ok_or_else(|| "Preset unavailable.".to_string())?;
    app.update(|data| {
        data.device_presets.insert(device.clone(), name.into());
        if data.output == device {
            data.settings = settings;
        }
    })
}

#[tauri::command]
fn sound_settings() -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg("ms-settings:sound")
        .spawn()
        .map_err(error)?;
    Ok(())
}

fn main() {
    use windows::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS},
        System::Threading::CreateMutexW,
    };
    let mutex = unsafe {
        let Ok(handle) = CreateMutexW(
            None,
            false,
            windows::core::w!("Local\\Equalizer.AudioEngine"),
        ) else {
            return;
        };
        if GetLastError() == ERROR_ALREADY_EXISTS {
            let _ = CloseHandle(handle);
            use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONWARNING, MB_OK};
            MessageBoxW(None,
                windows::core::w!("Equalizer is already running. Close it from the system tray before opening another copy."),
                windows::core::w!("Equalizer"), MB_OK | MB_ICONWARNING);
            return;
        }
        handle
    };
    tauri::Builder::default()
        .setup(|app| {
            let directory = app.path().app_local_data_dir()?;
            fs::create_dir_all(&directory)?;
            let file = directory.join("settings.json");
            let mut library = fs::read(&file)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Library>(&bytes).ok())
                .unwrap_or_default();
            if library.settings.validate().is_err() {
                library.settings = Settings::default();
            }
            library
                .presets
                .retain(|_, settings| settings.validate().is_ok());
            seed_default_presets(&mut library);
            let audio = Audio::start(library.route(), library.settings.clone());
            app.manage(App {
                audio,
                library: Mutex::new(library.clone()),
                file,
                routing: Mutex::new(()),
                keep_in_tray_item: Mutex::new(None),
            });
            let keep_in_tray =
                tauri::menu::CheckMenuItemBuilder::with_id("keep_in_tray", "Keep in tray")
                    .checked(!library.quit_on_close)
                    .build(app)?;
            let open_at_startup =
                tauri::menu::CheckMenuItemBuilder::with_id("open_at_startup", "Open at startup")
                    .checked(startup_enabled())
                    .build(app)?;
            if let Ok(mut guard) = app.state::<App>().keep_in_tray_item.lock() {
                *guard = Some(keep_in_tray.clone());
            }
            let menu = tauri::menu::MenuBuilder::new(app)
                .text("open", "Open Equalizer")
                .text("sound", "Windows sound settings")
                .separator()
                .item(&keep_in_tray)
                .item(&open_at_startup)
                .separator()
                .text("quit", "Quit Equalizer")
                .build()?;
            let keep_in_tray_handle = keep_in_tray.clone();
            let open_at_startup_handle = open_at_startup.clone();
            let mut tray = tauri::tray::TrayIconBuilder::new()
                .tooltip("Equalizer")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "sound" => {
                        let _ = sound_settings();
                    }
                    "keep_in_tray" => {
                        let checked = keep_in_tray_handle.is_checked().unwrap_or(true);
                        let _ = app
                            .state::<App>()
                            .update(|data| data.quit_on_close = !checked);
                    }
                    "open_at_startup" => {
                        let checked = open_at_startup_handle.is_checked().unwrap_or(false);
                        if set_startup(checked).is_err() {
                            let _ = open_at_startup_handle.set_checked(!checked);
                        }
                    }
                    "quit" => {
                        let handle = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            match restore_playback(&handle.state::<App>(), None) {
                                Ok((Some(_), _, _)) => handle.exit(0),
                                Ok((None, _, _)) => {
                                    let _ = sound_settings();
                                }
                                Err(reason) => {
                                    eprintln!("Equalizer could not restore playback: {reason}");
                                    let _ = sound_settings();
                                }
                            }
                        });
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let quit = window
                    .state::<App>()
                    .library
                    .lock()
                    .map(|data| data.quit_on_close)
                    .unwrap_or(false);
                if quit {
                    let handle = window.app_handle().clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        match restore_playback(&handle.state::<App>(), None) {
                            Ok((Some(_), _, _)) => handle.exit(0),
                            _ => {
                                let _ = sound_settings();
                            }
                        }
                    });
                } else {
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            library,
            devices,
            meter,
            route,
            auto_setup,
            disable_routing,
            set_close_behavior,
            speaker_volume,
            driver_website,
            update_settings,
            response,
            preset,
            assign_device_preset,
            sound_settings
        ])
        .run(tauri::generate_context!())
        .expect("Equalizer failed to start");
    unsafe {
        let _ = CloseHandle(mutex);
    }
}

fn default_presets() -> Vec<(&'static str, Settings)> {
    use dsp::{Band, Compressor, Effect, EffectKind, Saturation, Shape, Spatial, Tone};

    let band = |id, shape, hz, gain, q| Band {
        id,
        shape,
        hz,
        gain,
        q,
        enabled: true,
    };

    vec![
        ("Flat", Settings::default()),
        (
            "Warm & Musical",
            Settings {
                tone: Tone::default(),
                bass: 2.5,
                treble: -1.0,
                bands: vec![
                    band(1, Shape::Bell, 250., 1.5, 0.8),
                    band(2, Shape::Bell, 3200., -1.5, 1.4),
                    band(3, Shape::HighShelf, 10000., 1.0, 0.707),
                ],
                ..Settings::default()
            },
        ),
        (
            "Bass Boost",
            Settings {
                tone: Tone::default(),
                bass: 6.0,
                treble: 0.5,
                bands: vec![
                    band(1, Shape::Bell, 60., 2.5, 0.9),
                    band(2, Shape::Bell, 220., -1.5, 1.2),
                ],
                ..Settings::default()
            },
        ),
        (
            "Vocal Clarity",
            Settings {
                tone: Tone::default(),
                bass: 0.0,
                treble: 1.5,
                bands: vec![
                    band(1, Shape::LowCut, 80., 0.0, 0.707),
                    band(2, Shape::Bell, 240., -2.0, 1.1),
                    band(3, Shape::Bell, 2800., 3.0, 1.0),
                    band(4, Shape::Bell, 6000., 1.5, 1.2),
                ],
                ..Settings::default()
            },
        ),
        (
            "Acoustic & Jazz",
            Settings {
                tone: Tone::default(),
                bass: 1.5,
                treble: 1.5,
                bands: vec![
                    band(1, Shape::Bell, 85., 1.5, 0.8),
                    band(2, Shape::Bell, 500., -1.0, 1.0),
                    band(3, Shape::Bell, 2500., 1.5, 0.9),
                    band(4, Shape::HighShelf, 8500., 2.0, 0.707),
                ],
                ..Settings::default()
            },
        ),
        (
            "Electronic & Pop",
            Settings {
                tone: Tone::default(),
                bass: 4.5,
                treble: 2.5,
                bands: vec![
                    band(1, Shape::LowShelf, 90., 2.0, 0.707),
                    band(2, Shape::Bell, 550., -2.0, 0.9),
                    band(3, Shape::Bell, 3500., 2.0, 1.0),
                    band(4, Shape::HighShelf, 10000., 2.0, 0.707),
                ],
                ..Settings::default()
            },
        ),
        (
            "Late Night",
            Settings {
                tone: Tone::default(),
                bass: 1.5,
                treble: 0.5,
                bands: vec![band(1, Shape::LowCut, 35., 0.0, 0.707)],
                effects: vec![Effect {
                    id: 1,
                    kind: EffectKind::Compressor,
                    amount: -22.0,
                    enabled: true,
                    compressor: Compressor {
                        ratio: 3.0,
                        attack: 8.0,
                        release: 160.0,
                        knee: 6.0,
                        makeup: 2.5,
                        mix: 100.0,
                        rms: true,
                        auto_makeup: false,
                    },
                    saturation: Saturation::default(),
                    spatial: Spatial::default(),
                }],
                ..Settings::default()
            },
        ),
        (
            "Wide Soundstage",
            Settings {
                tone: Tone::default(),
                bass: 2.0,
                treble: 1.0,
                effects: vec![Effect {
                    id: 1,
                    kind: EffectKind::SpatialExpander,
                    amount: 35.0,
                    enabled: true,
                    compressor: Compressor::default(),
                    saturation: Saturation::default(),
                    spatial: Spatial {
                        bass_hz: 150.0,
                        ambience: 20.0,
                    },
                }],
                ..Settings::default()
            },
        ),
    ]
}

fn seed_default_presets(library: &mut Library) {
    for (name, settings) in default_presets() {
        library.presets.entry(name.into()).or_insert(settings);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_presets_are_valid_and_seeded() {
        let mut library = Library::default();
        seed_default_presets(&mut library);
        assert_eq!(library.presets.len(), default_presets().len());
        for (name, settings) in &library.presets {
            assert!(settings.validate().is_ok(), "invalid preset: {name}");
        }
    }
}
