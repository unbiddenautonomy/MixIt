//! Flush-to-zero: denormal floats (tiny values left in filter states and reverb tails)
//! are up to 100× slower on x86. Audio threads switch them off.

/// Enables flush-to-zero and denormals-are-zero for the calling thread.
#[allow(deprecated, unsafe_code)]
pub fn disable_denormals() {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    unsafe {
        #[cfg(target_arch = "x86")]
        use std::arch::x86::{_mm_getcsr, _mm_setcsr};
        #[cfg(target_arch = "x86_64")]
        use std::arch::x86_64::{_mm_getcsr, _mm_setcsr};
        // FTZ (bit 15) and DAZ (bit 6).
        _mm_setcsr(_mm_getcsr() | 0x8040);
    }
    #[cfg(target_arch = "aarch64")]
    unsafe {
        let mut fpcr: u64;
        std::arch::asm!("mrs {}, fpcr", out(reg) fpcr);
        fpcr |= 1 << 24; // FZ
        std::arch::asm!("msr fpcr, {}", in(reg) fpcr);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn denormals_flush_to_zero() {
        super::disable_denormals();
        let tiny = std::hint::black_box(f32::MIN_POSITIVE);
        let r = std::hint::black_box(tiny / 4.0);
        #[cfg(any(target_arch = "x86", target_arch = "x86_64", target_arch = "aarch64"))]
        assert_eq!(r, 0.0);
        let _ = r;
    }
}
