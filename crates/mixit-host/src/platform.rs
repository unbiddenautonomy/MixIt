//! Everything that differs between Windows, macOS and Linux, in one place.
//!
//! The rest of the code asks this module instead of testing the operating system
//! itself. Each rule is a plain function of an [`Os`] and what the system reports,
//! so the tests check every platform's choices on any machine: a Linux build checks
//! where Windows keeps the library, and the other way round.

use std::path::{Path, PathBuf};

/// The desktop systems MixIt runs on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Os {
    Windows,
    MacOs,
    Linux,
}

impl Os {
    pub const ALL: [Os; 3] = [Os::Windows, Os::MacOs, Os::Linux];

    /// The system this build runs on (other Unix systems follow Linux).
    pub const fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::MacOs
        } else {
            Os::Linux
        }
    }

    /// Per-system defaults.
    pub const fn profile(self) -> Profile {
        match self {
            Os::Windows => Profile {
                os: self,
                // WASAPI in shared mode works in ~10 ms periods; 256 frames keeps the
                // request inside that without starving the device.
                buffer_frames: 256,
                audio_system: "Windows Audio (WASAPI)",
                file_manager: "File Explorer",
                keep_library_local: true,
            },
            Os::MacOs => Profile {
                os: self,
                buffer_frames: 256,
                audio_system: "Core Audio",
                file_manager: "Finder",
                keep_library_local: false,
            },
            Os::Linux => Profile {
                os: self,
                // ALSA and PipeWire's ALSA bridge crackle more readily at small
                // buffers on ordinary desktop kernels.
                buffer_frames: 512,
                audio_system: "ALSA / PipeWire",
                file_manager: "file manager",
                keep_library_local: false,
            },
        }
    }
}

/// Defaults that differ per system.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Profile {
    pub os: Os,
    /// Output buffer asked for on first start (the person can change it in Settings).
    pub buffer_frames: u32,
    /// The system's audio API, as the person would recognise it.
    pub audio_system: &'static str,
    /// What the system calls its file browser ("Show in Finder").
    pub file_manager: &'static str,
    /// Keep the library in the machine-local data folder rather than the roaming one
    /// (Windows syncs Roaming AppData on sign-in, which a large database slows down).
    pub keep_library_local: bool,
}

/// The folders the system reports, as `dirs` finds them. Any may be missing.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KnownDirs {
    pub home: Option<PathBuf>,
    /// Roaming data on Windows, Application Support on macOS, XDG data on Linux.
    pub data: Option<PathBuf>,
    /// Machine-local data (Local AppData on Windows; the same as `data` elsewhere).
    pub data_local: Option<PathBuf>,
    pub cache: Option<PathBuf>,
    /// The Music folder.
    pub audio: Option<PathBuf>,
    pub temp: PathBuf,
}

impl KnownDirs {
    /// What this machine reports.
    pub fn system() -> KnownDirs {
        KnownDirs {
            home: dirs::home_dir(),
            data: dirs::data_dir(),
            data_local: dirs::data_local_dir(),
            cache: dirs::cache_dir(),
            audio: dirs::audio_dir(),
            temp: std::env::temp_dir(),
        }
    }
}

/// Where MixIt keeps its files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppDirs {
    /// The library database.
    pub db: PathBuf,
    /// Decoded audio, safe to delete.
    pub cache: PathBuf,
    /// Library backups.
    pub backups: PathBuf,
    /// The person's own MixIt folder inside Music: recordings, mixes, practice tracks.
    pub music: PathBuf,
    /// Downloaded model files (the stem splitter and other helpers). Not a cache: a
    /// model is large and fetched once, so it lives beside the library.
    pub models: PathBuf,
}

pub const APP_FOLDER: &str = "MixIt";

impl AppDirs {
    /// This machine's folders.
    pub fn system() -> AppDirs {
        AppDirs::resolve(Os::current(), &KnownDirs::system(), |p| p.is_file())
    }

    /// The folders for `os`, given what it reports. `exists` says whether a library
    /// is already at a path, so moving the default never strands an existing one.
    pub fn resolve(os: Os, known: &KnownDirs, exists: impl Fn(&Path) -> bool) -> AppDirs {
        let home = known.home.clone();
        let fallback =
            || home.clone().unwrap_or_else(|| known.temp.clone()).join(format!(".{}", APP_FOLDER.to_lowercase()));
        let roaming = known.data.as_ref().map(|d| d.join(APP_FOLDER));
        let local = known.data_local.as_ref().or(known.data.as_ref()).map(|d| d.join(APP_FOLDER));
        let data = if os.profile().keep_library_local { local.or(roaming.clone()) } else { roaming.clone().or(local) }
            .unwrap_or_else(fallback);
        let mut db = data.join("library.db");
        // A library made before the default moved stays where it is.
        let old = roaming.as_ref().map(|r| r.join("library.db"));
        if let Some(old) = old.filter(|old| *old != db && !exists(&db) && exists(old)) {
            db = old;
        }
        let backups = db.parent().map(|p| p.join("Backups")).unwrap_or_else(|| data.join("Backups"));
        let cache = known.cache.clone().unwrap_or_else(|| known.temp.clone()).join(APP_FOLDER).join("decoded");
        let music = known
            .audio
            .clone()
            .or_else(|| home.as_ref().map(|h| if os == Os::Linux { h.clone() } else { h.join("Music") }))
            .unwrap_or_else(|| data.clone())
            .join(APP_FOLDER);
        let models = data.join("Models");
        AppDirs { db, cache, backups, music, models }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known(os: Os) -> KnownDirs {
        match os {
            Os::Windows => KnownDirs {
                home: Some(PathBuf::from("C:/Users/dj")),
                data: Some(PathBuf::from("C:/Users/dj/AppData/Roaming")),
                data_local: Some(PathBuf::from("C:/Users/dj/AppData/Local")),
                cache: Some(PathBuf::from("C:/Users/dj/AppData/Local")),
                audio: Some(PathBuf::from("C:/Users/dj/Music")),
                temp: PathBuf::from("C:/Temp"),
            },
            Os::MacOs => KnownDirs {
                home: Some(PathBuf::from("/Users/dj")),
                data: Some(PathBuf::from("/Users/dj/Library/Application Support")),
                data_local: Some(PathBuf::from("/Users/dj/Library/Application Support")),
                cache: Some(PathBuf::from("/Users/dj/Library/Caches")),
                audio: Some(PathBuf::from("/Users/dj/Music")),
                temp: PathBuf::from("/tmp"),
            },
            Os::Linux => KnownDirs {
                home: Some(PathBuf::from("/home/dj")),
                data: Some(PathBuf::from("/home/dj/.local/share")),
                data_local: Some(PathBuf::from("/home/dj/.local/share")),
                cache: Some(PathBuf::from("/home/dj/.cache")),
                audio: None,
                temp: PathBuf::from("/tmp"),
            },
        }
    }

    #[test]
    fn every_system_has_its_own_folders() {
        let none = |_: &Path| false;
        let w = AppDirs::resolve(Os::Windows, &known(Os::Windows), none);
        assert_eq!(w.db, PathBuf::from("C:/Users/dj/AppData/Local/MixIt/library.db"));
        assert_eq!(w.backups, PathBuf::from("C:/Users/dj/AppData/Local/MixIt/Backups"));
        assert_eq!(w.cache, PathBuf::from("C:/Users/dj/AppData/Local/MixIt/decoded"));
        assert_eq!(w.music, PathBuf::from("C:/Users/dj/Music/MixIt"));
        assert_eq!(w.models, PathBuf::from("C:/Users/dj/AppData/Local/MixIt/Models"));

        let m = AppDirs::resolve(Os::MacOs, &known(Os::MacOs), none);
        assert_eq!(m.db, PathBuf::from("/Users/dj/Library/Application Support/MixIt/library.db"));
        assert_eq!(m.cache, PathBuf::from("/Users/dj/Library/Caches/MixIt/decoded"));
        assert_eq!(m.music, PathBuf::from("/Users/dj/Music/MixIt"));
        assert_eq!(m.models, PathBuf::from("/Users/dj/Library/Application Support/MixIt/Models"));

        // No XDG music folder: the MixIt folder goes in home, as before.
        let l = AppDirs::resolve(Os::Linux, &known(Os::Linux), none);
        assert_eq!(l.db, PathBuf::from("/home/dj/.local/share/MixIt/library.db"));
        assert_eq!(l.cache, PathBuf::from("/home/dj/.cache/MixIt/decoded"));
        assert_eq!(l.music, PathBuf::from("/home/dj/MixIt"));
        assert_eq!(l.models, PathBuf::from("/home/dj/.local/share/MixIt/Models"));
    }

    #[test]
    fn an_existing_windows_library_stays_in_roaming() {
        let old = PathBuf::from("C:/Users/dj/AppData/Roaming/MixIt/library.db");
        let w = AppDirs::resolve(Os::Windows, &known(Os::Windows), |p| p == old);
        assert_eq!(w.db, old);
        assert_eq!(w.backups, PathBuf::from("C:/Users/dj/AppData/Roaming/MixIt/Backups"));
        // Once a local one exists it wins.
        let local = PathBuf::from("C:/Users/dj/AppData/Local/MixIt/library.db");
        let w = AppDirs::resolve(Os::Windows, &known(Os::Windows), |p| p == old || p == local);
        assert_eq!(w.db, local);
    }

    #[test]
    fn missing_folders_fall_back_sensibly() {
        for os in Os::ALL {
            let bare = KnownDirs { temp: PathBuf::from("/t"), ..KnownDirs::default() };
            let d = AppDirs::resolve(os, &bare, |_| false);
            assert_eq!(d.db, PathBuf::from("/t/.mixit/library.db"));
            assert_eq!(d.cache, PathBuf::from("/t/MixIt/decoded"));
            assert_eq!(d.music, PathBuf::from("/t/.mixit/MixIt"));
            let home_only =
                KnownDirs { home: Some(PathBuf::from("/h")), temp: PathBuf::from("/t"), ..KnownDirs::default() };
            let d = AppDirs::resolve(os, &home_only, |_| false);
            assert_eq!(d.db, PathBuf::from("/h/.mixit/library.db"));
            let music = if os == Os::Linux { "/h/MixIt" } else { "/h/Music/MixIt" };
            assert_eq!(d.music, PathBuf::from(music));
        }
    }

    #[test]
    fn profiles_differ_where_the_systems_do() {
        assert_eq!(Os::Windows.profile().file_manager, "File Explorer");
        assert_eq!(Os::MacOs.profile().file_manager, "Finder");
        assert!(Os::Linux.profile().buffer_frames >= Os::MacOs.profile().buffer_frames);
        for os in Os::ALL {
            let p = os.profile();
            assert_eq!(p.os, os);
            assert!(p.buffer_frames.is_power_of_two() && (128..=1024).contains(&p.buffer_frames));
        }
        assert!(Os::Windows.profile().keep_library_local);
    }
}
