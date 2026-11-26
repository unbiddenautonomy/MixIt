//! Model files: which ones MixIt knows, where they live and how they arrive.
//!
//! A model is downloaded once, the first time something needs it, into the models
//! folder beside the library. The download goes to a temporary file, its SHA-256 is
//! checked against the one written here, and only then is it renamed into place, so a
//! half-finished or tampered file is never used. A machine with no internet can get the
//! same file another way and [`ModelStore::install`] it, with the same check.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::{MlError, Result};

/// A model file MixIt can use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModelInfo {
    /// Short id, also the method name stems are cached under.
    pub id: &'static str,
    /// What it is, in plain words.
    pub name: &'static str,
    pub file: &'static str,
    pub url: &'static str,
    /// Lowercase hex.
    pub sha256: &'static str,
    pub bytes: u64,
    /// Where it comes from and its terms, for the licence audit.
    pub source: &'static str,
}

/// HTDemucs (Meta's Hybrid Transformer Demucs, four stems), exported to ONNX with its
/// weights stored at half precision. Input is 7.8 s of 44.1 kHz stereo; output is
/// drums, bass, other and vocals.
pub const HTDEMUCS: ModelInfo = ModelInfo {
    id: "htdemucs",
    name: "Stem splitter (HTDemucs)",
    file: "htdemucs_fp16weights.onnx",
    url: "https://huggingface.co/adowu/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx",
    sha256: "d05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a",
    bytes: 165_612_636,
    source: "HTDemucs by Rouard, Massa and Défossez (Meta AI), MIT code; ONNX export by StemSplit \
             (huggingface.co/adowu/htdemucs-onnx, tagged MIT). Upstream weights licence to confirm \
             in the licence audit.",
};

const CLAP_SOURCE: &str = "CLAP (larger_clap_music_and_speech) by LAION, Apache-2.0; ONNX export with 8-bit \
                           weights by Xenova (huggingface.co/Xenova/larger_clap_music_and_speech).";

/// The sound listener (LAION's CLAP, trained on music and speech): ten seconds of
/// 48 kHz audio in, a 512-number description of how it sounds out. 8-bit weights.
pub const CLAP_AUDIO: ModelInfo = ModelInfo {
    id: "clap-audio",
    name: "Sound listener (CLAP)",
    file: "clap_ms_audio_quantized.onnx",
    url: "https://huggingface.co/Xenova/larger_clap_music_and_speech/resolve/e9fd5ac1dbf3280936a7fc3ec8a020453ff184db/onnx/audio_model_quantized.onnx",
    sha256: "021dd4fb962b4ed20cc3a6730b09e0ccf9f9c49931047032118a3b64828513a6",
    bytes: 78_155_433,
    source: CLAP_SOURCE,
};

/// CLAP's other half: words in, the same kind of 512 numbers out, so a description
/// ("dark rolling bass") can be compared with how tracks sound.
pub const CLAP_TEXT: ModelInfo = ModelInfo {
    id: "clap-text",
    name: "Sound describer (CLAP)",
    file: "clap_ms_text_quantized.onnx",
    url: "https://huggingface.co/Xenova/larger_clap_music_and_speech/resolve/e9fd5ac1dbf3280936a7fc3ec8a020453ff184db/onnx/text_model_quantized.onnx",
    sha256: "8f9f29c5f6adee917553d4b3a70729c731c0d18b88efca0ae67c1a1fc278f3b6",
    bytes: 126_603_262,
    source: CLAP_SOURCE,
};

/// The word list CLAP's describer reads with (RoBERTa's).
pub const CLAP_TOKENIZER: ModelInfo = ModelInfo {
    id: "clap-tokenizer",
    name: "Sound describer's word list",
    file: "clap_ms_tokenizer.json",
    url: "https://huggingface.co/Xenova/larger_clap_music_and_speech/resolve/e9fd5ac1dbf3280936a7fc3ec8a020453ff184db/tokenizer.json",
    sha256: "dc239041d98de27ffc3975473a1a23e3db4c937b23c138c38bbc66588bd247e5",
    bytes: 2_108_774,
    source: CLAP_SOURCE,
};

/// The beat helper (Beat This!, its main model): 30 s of log-mel spectrogram in, how
/// likely a beat and a downbeat are at each of its 50 frames a second out.
pub const BEAT_THIS: ModelInfo = ModelInfo {
    id: "beat-this-final0",
    name: "Beat helper (Beat This!)",
    file: "beat_this_final0.onnx",
    url: "https://huggingface.co/musetric/beat-this-onnx/resolve/25308706dda545c0d5950065bb0604ad71bcf1f5/beat_this.onnx",
    sha256: "1337dc6c21257ed6b803418efc320df42b5d8eb296ef16648ef60457cd4b9e55",
    bytes: 190_649_026,
    source: "Beat This! by Foscarin, Schlüter and Widmer (CPJKU, JKU Linz), MIT code and weights \
             (github.com/CPJKU/beat_this); final0 checkpoint exported to ONNX by musetric \
             (huggingface.co/musetric/beat-this-onnx, tagged MIT).",
};

/// Every model MixIt knows about.
pub const ALL: &[ModelInfo] = &[HTDEMUCS, CLAP_AUDIO, CLAP_TEXT, CLAP_TOKENIZER, BEAT_THIS];

/// The models folder.
#[derive(Clone, Debug)]
pub struct ModelStore {
    dir: PathBuf,
}

impl ModelStore {
    pub fn new(dir: impl Into<PathBuf>) -> ModelStore {
        ModelStore { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn path(&self, info: &ModelInfo) -> PathBuf {
        self.dir.join(info.file)
    }

    /// The model's file, if it is there and the right size. (The full checksum was
    /// checked when it arrived; reading 166 MB on every use would be slow.)
    pub fn get(&self, info: &ModelInfo) -> Option<PathBuf> {
        let p = self.path(info);
        let len = std::fs::metadata(&p).ok()?.len();
        (len == info.bytes).then_some(p)
    }

    /// Downloads the model if it is not there yet. `progress` gets 0..1 and returns
    /// false to stop.
    pub fn fetch(&self, info: &ModelInfo, mut progress: impl FnMut(f32) -> bool) -> Result<PathBuf> {
        if let Some(p) = self.get(info) {
            return Ok(p);
        }
        let mut resp = ureq::get(info.url).call().map_err(|e| MlError::Download(e.to_string()))?;
        let reader = resp.body_mut().as_reader();
        self.write_checked(info, reader, &mut progress)
    }

    /// Puts a model file obtained another way (for a computer with no internet) in
    /// place, after checking it is the right file.
    pub fn install(&self, info: &ModelInfo, from: &Path) -> Result<PathBuf> {
        let f = std::fs::File::open(from)?;
        self.write_checked(info, f, &mut |_| true)
    }

    /// Removes a downloaded model.
    pub fn remove(&self, info: &ModelInfo) -> Result<()> {
        match std::fs::remove_file(self.path(info)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }

    fn write_checked(
        &self,
        info: &ModelInfo,
        mut from: impl Read,
        progress: &mut dyn FnMut(f32) -> bool,
    ) -> Result<PathBuf> {
        std::fs::create_dir_all(&self.dir)?;
        let dest = self.path(info);
        let tmp = dest.with_extension("part");
        let r = (|| {
            let mut out = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
            let mut hash = Sha256::new();
            let mut buf = vec![0u8; 1 << 16];
            let mut got = 0u64;
            loop {
                let n = from.read(&mut buf).map_err(|e| MlError::Download(e.to_string()))?;
                if n == 0 {
                    break;
                }
                got += n as u64;
                if got > info.bytes {
                    return Err(MlError::Checksum);
                }
                hash.update(&buf[..n]);
                out.write_all(&buf[..n])?;
                if !progress(got as f32 / info.bytes as f32) {
                    return Err(MlError::Cancelled);
                }
            }
            out.flush()?;
            drop(out);
            if got != info.bytes || hex(&hash.finalize()) != info.sha256 {
                return Err(MlError::Checksum);
            }
            std::fs::rename(&tmp, &dest)?;
            Ok(dest.clone())
        })();
        if r.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        r
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny(sha256: &'static str, bytes: u64) -> ModelInfo {
        ModelInfo { id: "tiny", name: "Tiny", file: "tiny.bin", url: "", sha256, bytes, source: "" }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mixit-ml-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn installs_a_file_only_when_its_checksum_matches() {
        let dir = temp_dir("install");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("source");
        std::fs::write(&src, b"hello").unwrap();
        // sha256("hello")
        let good = tiny("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", 5);
        let store = ModelStore::new(dir.join("models"));
        assert!(store.get(&good).is_none());
        let p = store.install(&good, &src).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"hello");
        assert_eq!(store.get(&good), Some(p));

        let bad = ModelInfo { file: "bad.bin", ..tiny("00", 5) };
        assert!(matches!(store.install(&bad, &src), Err(MlError::Checksum)));
        assert!(store.get(&bad).is_none());
        // Nothing half-written is left behind.
        assert!(!store.path(&bad).with_extension("part").exists());

        let long = ModelInfo { file: "long.bin", ..tiny("00", 3) };
        assert!(matches!(store.install(&long, &src), Err(MlError::Checksum)));
        store.remove(&good).unwrap();
        assert!(store.get(&good).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_known_model_has_a_checksum_and_size() {
        for m in ALL {
            assert_eq!(m.sha256.len(), 64, "{}", m.id);
            assert!(m.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert!(m.bytes > 0 && m.url.starts_with("https://"));
        }
    }
}
