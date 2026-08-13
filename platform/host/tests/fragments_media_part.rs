//! The media part end to end in the wasmtime host: FFmpeg compiled to
//! wasip1 probing, thumbnailing, extracting, trimming, and converting the
//! committed fixtures, with file grants in and produced files out, and the
//! WAV conversion running as a job across steps.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use dynamic_experience_runtime_lib::fragments::{
    verify_bundle, ExecEnv, FragmentsState, LoadedFragment,
};
use serde_json::{json, Value};

const BUNDLE: &str = "../../fragments/dist/der-labs.media.derpart";

struct Harness {
    dir: PathBuf,
    kept: Mutex<Vec<PathBuf>>,
}

impl Harness {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("der-media-{}-{}", tag, std::process::id()));
        std::fs::create_dir_all(&dir).expect("harness dir");
        Self { dir, kept: Mutex::new(Vec::new()) }
    }

    fn fixture(&self, name: &str) -> String {
        format!("granted-{}", name)
    }

    fn exec_env<'a>(
        &'a self,
        resolve: &'a dyn Fn(&str) -> Option<PathBuf>,
        register: &'a dyn Fn(&Path) -> Result<Value, String>,
    ) -> ExecEnv<'a> {
        ExecEnv { resolve_grant: resolve, register_output: register }
    }
}

/// One engine and one compiled module for the whole suite: cranelift on
/// 5.5MB of FFmpeg is the slow part, and every test shares it safely.
fn shared() -> &'static (FragmentsState, LoadedFragment) {
    use std::sync::OnceLock;
    static SHARED: OnceLock<(FragmentsState, LoadedFragment)> = OnceLock::new();
    SHARED.get_or_init(|| {
        let state = FragmentsState::new();
        let raw = std::fs::read(BUNDLE).expect("committed media bundle present");
        let verified = verify_bundle(&raw).expect("bundle verifies");
        let module = state
            .compile(&verified.wasm, &verified.manifest.capabilities)
            .expect("media module passes the capability verifier");
        let loaded = LoadedFragment::for_tests(verified.manifest, module);
        (state, loaded)
    })
}

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from("tests/fixtures/media").join(name)
}

fn run_op(
    state: &FragmentsState,
    loaded: &LoadedFragment,
    harness: &Harness,
    operation: &str,
    inputs: Value,
) -> Result<Value, String> {
    let resolve = |token: &str| {
        token
            .strip_prefix("granted-")
            .map(|name| fixture_path(name))
            .filter(|path| path.is_file())
    };
    let register = |produced: &Path| {
        let name = produced
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let kept = harness.dir.join(&name);
        std::fs::copy(produced, &kept).map_err(|e| e.to_string())?;
        let size = std::fs::metadata(&kept).map(|m| m.len()).unwrap_or(0);
        harness.kept.lock().unwrap().push(kept);
        Ok(json!({
            "file": format!("produced-{}", name),
            "url": format!("asset://{}", name),
            "name": name,
            "size": size,
        }))
    };
    let exec_env = harness.exec_env(&resolve, &register);
    state
        .execute_operation_with(loaded, operation, &inputs, &exec_env)
        .map_err(|error| error.message)
}

#[test]
fn probes_the_committed_clip() {
    let (state, loaded) = shared();
    let harness = Harness::new("probe");

    let result = run_op(
        state,
        loaded,
        &harness,
        "media.probe",
        json!({ "file": harness.fixture("clip.mp4") }),
    )
    .expect("probes");

    assert!(result["format"].as_str().unwrap_or("").contains("mp4"));
    let duration = result["durationSeconds"].as_f64().expect("duration");
    assert!((1.5..=2.5).contains(&duration), "duration {}", duration);
    let streams = result["streams"].as_array().expect("streams");
    let kinds: Vec<&str> = streams
        .iter()
        .filter_map(|s| s["kind"].as_str())
        .collect();
    assert!(kinds.contains(&"video") && kinds.contains(&"audio"));
    let video = streams.iter().find(|s| s["kind"] == "video").expect("video row");
    assert_eq!(video["codec"], "h264");
    assert_eq!(video["width"], 320.0);
}

#[test]
fn thumbnails_a_frame_as_jpeg() {
    let (state, loaded) = shared();
    let harness = Harness::new("thumb");

    let result = run_op(
        state,
        loaded,
        &harness,
        "media.thumbnail",
        json!({ "file": harness.fixture("clip.mp4"), "atSeconds": 1.0 }),
    )
    .expect("thumbnails");

    assert_eq!(result["file"], "produced-thumbnail.jpg");
    let kept = harness.kept.lock().unwrap();
    let bytes = std::fs::read(&kept[0]).expect("jpeg bytes");
    assert!(bytes.len() > 500);
    assert_eq!(&bytes[0..2], &[0xFF, 0xD8], "JPEG SOI marker");
}

#[test]
fn extracts_the_audio_track_as_m4a() {
    let (state, loaded) = shared();
    let harness = Harness::new("extract");

    let result = run_op(
        state,
        loaded,
        &harness,
        "media.audioExtract",
        json!({ "file": harness.fixture("clip.mp4") }),
    )
    .expect("extracts");

    assert_eq!(result["codec"], "aac");
    assert_eq!(result["file"], "produced-audio.m4a");
    let kept = harness.kept.lock().unwrap();
    let size = std::fs::metadata(&kept[0]).expect("kept").len();
    assert!(size > 2_000, "audio track has substance, got {}", size);
}

#[test]
fn trims_a_segment_by_stream_copy() {
    let (state, loaded) = shared();
    let harness = Harness::new("trim");

    let result = run_op(
        state,
        loaded,
        &harness,
        "media.trim",
        json!({ "file": harness.fixture("clip.mp4"), "fromSeconds": 0, "toSeconds": 1 }),
    )
    .expect("trims");

    assert_eq!(result["file"], "produced-trimmed.mp4");
    let kept = harness.kept.lock().unwrap();
    let trimmed = std::fs::metadata(&kept[0]).expect("kept").len();
    let original = std::fs::metadata(fixture_path("clip.mp4")).expect("fixture").len();
    assert!(trimmed > 1_000 && trimmed < original, "trimmed {} vs {}", trimmed, original);
}

#[test]
fn converts_mp3_to_wav_as_a_job() {
    let (state, loaded) = shared();
    let harness = Harness::new("towav");

    let started = run_op(
        state,
        loaded,
        &harness,
        "media.toWav",
        json!({ "file": harness.fixture("tone.mp3") }),
    )
    .expect("job starts");
    let token = started["job"].as_str().expect("token").to_string();
    let duration = started["durationSeconds"].as_f64().expect("duration");
    assert!((2.5..=3.5).contains(&duration));

    let mut steps = 0;
    let final_result = loop {
        steps += 1;
        assert!(steps < 50, "job never finished");
        let step = run_op(
            &state,
            &loaded,
            &harness,
            "media.toWavStep",
            json!({ "job": token }),
        )
        .expect("step runs");
        if step["done"] == Value::Bool(true) {
            break step;
        }
    };

    assert_eq!(final_result["file"], "produced-audio.wav");
    let kept = harness.kept.lock().unwrap();
    let wav = std::fs::read(kept.last().expect("wav kept")).expect("wav bytes");
    assert_eq!(&wav[0..4], b"RIFF");
    // 3 seconds of 44.1kHz mono s16 is roughly 260KB; accept a wide band.
    assert!(wav.len() > 100_000, "wav has substance, got {}", wav.len());
}
