//! The C ABI the page calls (no bindings generator: the module must also load inside an
//! AudioWorklet, which cannot import ES-module glue).
//!
//! Conventions:
//! - Text goes in as UTF-8 bytes the page writes into memory from [`mx_alloc_bytes`].
//! - Functions that can fail return 0 on success and 1 on error; either way the reply
//!   (JSON, or the error message) is in the output buffer: [`mx_out_ptr`] / [`mx_out_len`].
//! - Audio comes back in a float output buffer ([`mx_out_f32_ptr`]), binary data in a
//!   byte buffer ([`mx_out_bin_ptr`]). Each call replaces them.
//! - Audio handed to a `load` call is owned by the engine afterwards; the page must not
//!   free it.
//!
//! The page re-creates its typed-array views after any call, since memory can grow.

use std::cell::RefCell;

use crate::host::{Host, LoadOptions, PadSettings};
use crate::render::{RenderJob, RenderRequest, TrackOptions};
use crate::tools;

thread_local! {
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUT_F32: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    static OUT_BIN: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn reply(r: Result<String, String>) -> i32 {
    let (code, text) = match r {
        Ok(s) => (0, s),
        Err(e) => (1, e),
    };
    OUT.with(|o| *o.borrow_mut() = text.into_bytes());
    code
}

/// Reads text the page wrote.
///
/// # Safety
/// `ptr..ptr+len` must be readable memory the page wrote.
unsafe fn text<'a>(ptr: *const u8, len: usize) -> Result<&'a str, String> {
    if ptr.is_null() {
        return Ok("");
    }
    let b = unsafe { std::slice::from_raw_parts(ptr, len) };
    std::str::from_utf8(b).map_err(|e| e.to_string())
}

/// Takes ownership of audio the page wrote into a buffer from [`mx_alloc_f32`].
///
/// # Safety
/// `ptr` must come from `mx_alloc_f32(count)` and not be used again by the page.
unsafe fn take_f32(ptr: *mut f32, count: usize) -> Vec<f32> {
    unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, count)) }.into_vec()
}

#[unsafe(no_mangle)]
pub extern "C" fn mx_alloc_bytes(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}

/// # Safety
/// `ptr` must come from `mx_alloc_bytes(len)` and not be freed twice.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_free_bytes(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn mx_alloc_f32(count: usize) -> *mut f32 {
    Box::into_raw(vec![0f32; count].into_boxed_slice()) as *mut f32
}

/// # Safety
/// `ptr` must come from `mx_alloc_f32(count)` and not be freed twice or handed to a load.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_free_f32(ptr: *mut f32, count: usize) {
    if !ptr.is_null() {
        drop(unsafe { take_f32(ptr, count) });
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn mx_out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn mx_out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}

#[unsafe(no_mangle)]
pub extern "C" fn mx_out_f32_ptr() -> *const f32 {
    OUT_F32.with(|o| o.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn mx_out_f32_len() -> usize {
    OUT_F32.with(|o| o.borrow().len())
}

#[unsafe(no_mangle)]
pub extern "C" fn mx_out_bin_ptr() -> *const u8 {
    OUT_BIN.with(|o| o.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn mx_out_bin_len() -> usize {
    OUT_BIN.with(|o| o.borrow().len())
}

// ------------------------------------------------------------------ engine host

#[unsafe(no_mangle)]
pub extern "C" fn mx_host_new(sample_rate: u32) -> *mut Host {
    Box::into_raw(Box::new(Host::new(sample_rate)))
}

/// Renders `frames` and returns a pointer to interleaved stereo master output (valid
/// until the next call); the headphone cue follows at [`mx_host_cue`].
///
/// # Safety
/// `h` must come from [`mx_host_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_host_process(h: *mut Host, frames: usize) -> *const f32 {
    let h = unsafe { &mut *h };
    h.process(frames).0.as_ptr()
}

/// The headphone cue of the last [`mx_host_process`] call.
///
/// # Safety
/// `h` must come from [`mx_host_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_host_cue(h: *mut Host) -> *const f32 {
    let h = unsafe { &*h };
    h.cue_buffer().as_ptr()
}

/// Telemetry and ended decks as JSON in the output buffer.
///
/// # Safety
/// `h` must come from [`mx_host_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_host_poll(h: *mut Host) -> i32 {
    let h = unsafe { &mut *h };
    reply(serde_json::to_string(&h.poll()).map_err(|e| e.to_string()))
}

/// Where the worklet writes a quantum of mic input (interleaved stereo, up to 4096
/// frames) before [`mx_host_mic_push`].
///
/// # Safety
/// `h` must come from [`mx_host_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_host_mic_in(h: *mut Host) -> *mut f32 {
    let h = unsafe { &mut *h };
    h.mic_buffer().as_mut_ptr()
}

/// Passes `frames` of mic input to the engine (after a `micOpen` call).
///
/// # Safety
/// `h` must come from [`mx_host_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_host_mic_push(h: *mut Host, frames: usize) {
    let h = unsafe { &mut *h };
    h.push_mic(frames);
}

/// Moves the mic recording captured since the last call into the float output buffer and
/// returns its length in samples (interleaved stereo).
///
/// # Safety
/// `h` must come from [`mx_host_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_host_capture(h: *mut Host) -> usize {
    let h = unsafe { &mut *h };
    let c = h.take_capture();
    let n = c.len();
    OUT_F32.with(|o| {
        let mut o = o.borrow_mut();
        o.clear();
        o.extend_from_slice(c);
    });
    n
}

/// One JSON call (see `Host::call`).
///
/// # Safety
/// `h` from [`mx_host_new`]; `ptr..ptr+len` written by the page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_host_call(h: *mut Host, ptr: *const u8, len: usize) -> i32 {
    let h = unsafe { &mut *h };
    let r = unsafe { text(ptr, len) }.and_then(|m| h.call(m)).map(|v| v.to_string());
    reply(r)
}

/// Loads audio (taken over) onto a deck. Replies `{"token": n}`.
///
/// # Safety
/// `h` from [`mx_host_new`]; `audio` from `mx_alloc_f32(count)`; options text as above.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_host_load(
    h: *mut Host,
    deck: usize,
    audio: *mut f32,
    count: usize,
    opts: *const u8,
    opts_len: usize,
) -> i32 {
    let h = unsafe { &mut *h };
    let audio = unsafe { take_f32(audio, count) };
    let r = unsafe { text(opts, opts_len) }
        .and_then(|t| {
            if t.is_empty() { Ok(LoadOptions::default()) } else { serde_json::from_str(t).map_err(|e| e.to_string()) }
        })
        .and_then(|o| h.load(deck, audio, o))
        .map(|token| format!("{{\"token\":{token}}}"));
    reply(r)
}

/// Loads audio (taken over) onto a sampler pad. Options: `{"bpm": n|null, "settings": {...}}`.
///
/// # Safety
/// As [`mx_host_load`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_host_load_pad(
    h: *mut Host,
    pad: usize,
    audio: *mut f32,
    count: usize,
    opts: *const u8,
    opts_len: usize,
) -> i32 {
    let h = unsafe { &mut *h };
    let audio = unsafe { take_f32(audio, count) };
    #[derive(serde::Deserialize)]
    struct PadLoad {
        bpm: Option<f64>,
        settings: PadSettings,
    }
    let r = unsafe { text(opts, opts_len) }
        .and_then(|t| serde_json::from_str::<PadLoad>(t).map_err(|e| e.to_string()))
        .and_then(|o| h.load_pad(pad, audio, o.bpm, &o.settings))
        .map(|_| "null".to_string());
    reply(r)
}

/// Puts audio (taken over) in the preview player and plays it. Options: `{"start": s}`.
///
/// # Safety
/// As [`mx_host_load`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_host_load_preview(
    h: *mut Host,
    audio: *mut f32,
    count: usize,
    opts: *const u8,
    opts_len: usize,
) -> i32 {
    let h = unsafe { &mut *h };
    let audio = unsafe { take_f32(audio, count) };
    #[derive(serde::Deserialize)]
    struct PreviewLoad {
        #[serde(default)]
        start: f64,
    }
    let r = unsafe { text(opts, opts_len) }
        .and_then(|t| serde_json::from_str::<PreviewLoad>(t).map_err(|e| e.to_string()))
        .map(|o| {
            h.load_preview(audio, o.start);
            "null".to_string()
        });
    reply(r)
}

// ------------------------------------------------------------------ tools (worker)

/// The action registry and FX names, as the desktop's `app_info` sends them. Replies
/// `{"registry": [...], "fxTypes": [...]}`.
#[unsafe(no_mangle)]
pub extern "C" fn mx_registry() -> i32 {
    let v = serde_json::json!({
        "registry": mixit_core::actions::registry(crate::host::DECKS, crate::host::PADS),
        "fxTypes": mixit_core::actions::FX_TYPES,
    });
    reply(Ok(v.to_string()))
}

/// Generates a track (see `tools::GenerateRequest`). Audio in the float buffer; replies
/// `{"frames": n}`.
///
/// # Safety
/// `ptr..ptr+len` written by the page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_generate(ptr: *const u8, len: usize) -> i32 {
    let r = unsafe { text(ptr, len) }
        .and_then(|t| serde_json::from_str::<tools::GenerateRequest>(t).map_err(|e| e.to_string()))
        .and_then(|req| tools::generate(&req))
        .map(|audio| {
            let frames = audio.len() / 2;
            OUT_F32.with(|o| *o.borrow_mut() = audio);
            format!("{{\"frames\":{frames}}}")
        });
    reply(r)
}

/// Analyses interleaved stereo (not taken over). Replies with the analysis view; the
/// waveform is in the byte buffer.
///
/// # Safety
/// `audio..audio+count` readable floats.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_analyse(audio: *const f32, count: usize, sample_rate: u32) -> i32 {
    let x = unsafe { std::slice::from_raw_parts(audio, count) };
    let (view, wave) = tools::analyse(x, sample_rate);
    OUT_BIN.with(|o| *o.borrow_mut() = wave);
    reply(serde_json::to_string(&view).map_err(|e| e.to_string()))
}

/// Renders a built-in kit sound. Audio in the float buffer; replies `{"bpm", "mode"}`.
///
/// # Safety
/// `ptr..ptr+len` written by the page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_kit(ptr: *const u8, len: usize, sample_rate: u32) -> i32 {
    let r = unsafe { text(ptr, len) }.and_then(|id| tools::kit(id, sample_rate)).map(|(audio, bpm, mode)| {
        OUT_F32.with(|o| *o.borrow_mut() = audio);
        serde_json::json!({ "bpm": bpm, "mode": mode }).to_string()
    });
    reply(r)
}

/// Applies a list of sound edits (JSON, `mixit_engine::view::EditOpDto`) to interleaved
/// stereo (not taken over). The result is in the float buffer; replies with the sound's
/// view (length, peaks for `bins` bins, loudness).
///
/// # Safety
/// `audio..audio+count` readable floats; `ops..ops+len` written by the page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_sound_edit(
    audio: *const f32,
    count: usize,
    sample_rate: u32,
    ops: *const u8,
    len: usize,
    bins: usize,
) -> i32 {
    let x = unsafe { std::slice::from_raw_parts(audio, count) };
    let r = unsafe { text(ops, len) }
        .and_then(|t| serde_json::from_str::<Vec<mixit_engine::view::EditOpDto>>(t).map_err(|e| e.to_string()))
        .and_then(|ops| {
            let a = mixit_dsp::edit::apply(x, sample_rate, &mixit_engine::view::edit_ops(&ops));
            let view = mixit_engine::view::SoundViewDto::new(&a, sample_rate, bins);
            OUT_F32.with(|o| *o.borrow_mut() = a);
            serde_json::to_string(&view).map_err(|e| e.to_string())
        });
    reply(r)
}

// ------------------------------------------------------------------ arrange render (worker)

/// Starts rendering a mix project (`render::RenderRequest` as JSON). Returns the job, or
/// null with the error in the output; on success the reply is `{"frames": total}`.
///
/// # Safety
/// `ptr..ptr+len` written by the page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_render_new(ptr: *const u8, len: usize, sample_rate: u32) -> *mut RenderJob {
    let r = unsafe { text(ptr, len) }
        .and_then(|t| serde_json::from_str::<RenderRequest>(t).map_err(|e| e.to_string()))
        .and_then(|req| RenderJob::new(req, sample_rate));
    match r {
        Ok(job) => {
            reply(Ok(format!("{{\"frames\":{}}}", job.total_frames())));
            Box::into_raw(Box::new(job))
        }
        Err(e) => {
            reply(Err(e));
            std::ptr::null_mut()
        }
    }
}

/// Gives the job a track's audio (taken over), for every clip whose track path is
/// `path`. Options: `{"grid": Beatgrid, "autoGainDb": n}`.
///
/// # Safety
/// `job` from [`mx_render_new`]; `audio` from `mx_alloc_f32(count)`; text as above.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_render_track(
    job: *mut RenderJob,
    path: *const u8,
    path_len: usize,
    audio: *mut f32,
    count: usize,
    opts: *const u8,
    opts_len: usize,
) -> i32 {
    let job = unsafe { &mut *job };
    let audio = unsafe { take_f32(audio, count) };
    let r = unsafe { text(path, path_len) }.and_then(|p| {
        let o = unsafe { text(opts, opts_len) }
            .and_then(|t| serde_json::from_str::<TrackOptions>(t).map_err(|e| e.to_string()))?;
        job.provide(p, audio, o);
        Ok("null".to_string())
    });
    reply(r)
}

/// Tells the job a track cannot be found; the render then fails with its name.
///
/// # Safety
/// `job` from [`mx_render_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_render_missing(job: *mut RenderJob, path: *const u8, path_len: usize) -> i32 {
    let job = unsafe { &mut *job };
    let r = unsafe { text(path, path_len) }.map(|p| {
        job.missing(p);
        "null".to_string()
    });
    reply(r)
}

/// Renders up to `frames` frames. The audio is in the float buffer; the reply is
/// `{"frames", "position", "total", "need": {"clip", "path", "title"} | null, "done"}`.
///
/// # Safety
/// `job` from [`mx_render_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_render_next(job: *mut RenderJob, frames: usize) -> i32 {
    let job = unsafe { &mut *job };
    let r = OUT_F32
        .with(|o| job.next(frames, &mut o.borrow_mut()))
        .and_then(|p| serde_json::to_string(&p).map_err(|e| e.to_string()));
    reply(r)
}

/// Frees a render job.
///
/// # Safety
/// `job` from [`mx_render_new`], not used again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mx_render_free(job: *mut RenderJob) {
    if !job.is_null() {
        drop(unsafe { Box::from_raw(job) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out() -> String {
        String::from_utf8(unsafe { std::slice::from_raw_parts(mx_out_ptr(), mx_out_len()) }.to_vec()).unwrap()
    }

    fn put(s: &str) -> (*mut u8, usize) {
        let p = mx_alloc_bytes(s.len());
        unsafe { std::ptr::copy_nonoverlapping(s.as_ptr(), p, s.len()) };
        (p, s.len())
    }

    #[test]
    fn round_trip_through_the_abi() {
        let h = mx_host_new(48_000);
        let n = 48_000 * 2;
        let a = mx_alloc_f32(n);
        unsafe { std::slice::from_raw_parts_mut(a, n) }
            .iter_mut()
            .enumerate()
            .for_each(|(i, v)| *v = ((i / 2) as f32 * 0.05).sin() * 0.3);
        let (o, ol) = put(r#"{"cue":0}"#);
        assert_eq!(unsafe { mx_host_load(h, 0, a, n, o, ol) }, 0, "{}", out());
        unsafe { mx_free_bytes(o, ol) };
        assert!(out().contains("token"));
        let (c, cl) = put(r#"{"op":"action","id":"deck.A.play","input":{"type":"press"}}"#);
        assert_eq!(unsafe { mx_host_call(h, c, cl) }, 0);
        unsafe { mx_free_bytes(c, cl) };
        let mut energy = 0.0;
        for _ in 0..40 {
            let p = unsafe { mx_host_process(h, 128) };
            energy += unsafe { std::slice::from_raw_parts(p, 256) }.iter().map(|v| v * v).sum::<f32>();
        }
        assert!(energy > 1.0);
        assert_eq!(unsafe { mx_host_poll(h) }, 0);
        assert!(out().contains("\"playing\":true"));
        let (bad, bl) = put("{nope");
        assert_eq!(unsafe { mx_host_call(h, bad, bl) }, 1);
        unsafe { mx_free_bytes(bad, bl) };
        assert_eq!(mx_registry(), 0);
        assert!(out().contains("deck.D.play") && out().contains("fxTypes"));
        let (k, kl) = put("kick");
        assert_eq!(unsafe { mx_kit(k, kl, 48_000) }, 0);
        assert!(mx_out_f32_len() > 1000);
        unsafe { mx_free_bytes(k, kl) };
        drop(unsafe { Box::from_raw(h) });
    }
}
