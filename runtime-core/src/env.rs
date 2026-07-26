//! The runtime's environment boundary: ids, randomness, and the clock reach
//! operations only through this trait, so the conformance vectors script them
//! and production supplies real entropy.

use std::collections::VecDeque;

pub trait RuntimeEnv {
    fn next_id(&mut self) -> String;
    /// A roll in [0, 1), Math.random-shaped.
    fn next_random(&mut self) -> f64;
    fn epoch_ms(&self) -> i64;
    fn tz_offset_minutes(&self) -> i32;
}

/// Scripted values for the conformance vectors and tests.
pub struct ScriptedEnv {
    pub ids: VecDeque<String>,
    pub randoms: VecDeque<f64>,
    pub epoch_ms: i64,
    pub tz_offset_minutes: i32,
}

impl RuntimeEnv for ScriptedEnv {
    fn next_id(&mut self) -> String {
        self.ids
            .pop_front()
            .unwrap_or_else(|| format!("id-{}", self.epoch_ms))
    }

    fn next_random(&mut self) -> f64 {
        self.randoms.pop_front().unwrap_or(0.0)
    }

    fn epoch_ms(&self) -> i64 {
        self.epoch_ms
    }

    fn tz_offset_minutes(&self) -> i32 {
        self.tz_offset_minutes
    }
}

/// Real entropy and the real clock, for live sessions.
pub struct SystemEnv;

#[cfg(not(target_arch = "wasm32"))]
impl RuntimeEnv for SystemEnv {
    fn next_id(&mut self) -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn next_random(&mut self) -> f64 {
        rand::random::<f64>()
    }

    fn epoch_ms(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }

    fn tz_offset_minutes(&self) -> i32 {
        chrono::Local::now().offset().local_minus_utc() / 60
    }
}
