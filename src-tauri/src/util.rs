fn bisect<T: std::cmp::PartialOrd>(arr: &Vec<T>, val: T) -> isize {
    let mut lo = 0;
    let mut hi = arr.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if arr[mid] > val {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo as isize - 1
}

pub fn beat_bisect(subdivisions: &Vec<f64>, beat: f64) -> isize {
    let default_subdivisions = &vec![0.0, 1.0];
    // A cycle of no length can't be bisected: `beat / 0` is an infinite loop
    // count, which saturates to isize::MAX on the cast and then overflows to
    // isize::MIN on the way out -- a constant, so the click or the voice simply
    // stops triggering, with nothing anywhere saying why. The frontend rejects
    // a zero-length rhythm now, but a hand-written preset can still carry one,
    // and the audio thread shouldn't depend on somebody else's validation.
    // Only the span is checked, which is O(1): an interior time can't be
    // non-finite, because JSON has no NaN and serde won't take a null.
    let span = *subdivisions.last().unwrap_or(&0.0);
    let subdivisions = if subdivisions.len() < 2 || !(span > 0.0) || !span.is_finite() {
        &default_subdivisions
    } else {
        subdivisions
    };
    if !beat.is_finite() {
        return 0;
    }
    // the length of the subdivision loop is the last value of config subdivision
    let subdivision_len = subdivisions[subdivisions.len() - 1];
    let beats_per_loop = subdivisions.len() as isize - 1;
    let loop_count = (beat / subdivision_len).floor() as isize;
    let sub_beat = beat - (loop_count as f64 * subdivision_len);
    let bisection = bisect(subdivisions, sub_beat);
    loop_count * beats_per_loop + bisection
}

pub fn mod_add(a: usize, b: usize, max: usize) -> usize {
    // `res -= 0` never terminates, and this runs on the audio thread, so a zero
    // modulus is a hung callback holding every lock the IPC side needs -- the
    // worst failure in the file. Callers still have to not index an empty
    // buffer; this only makes sure we come back to tell them.
    if max == 0 {
        return 0;
    }
    let mut res = a + b;
    while res >= max {
        res -= max;
    }
    res
}

use crate::structs::Section;

/// Where each enabled section ends, as a running total in beats, paired with
/// its index in the config's list.
///
/// Written into a caller-owned vector because this runs once per callback and
/// the audio thread never reaches for the allocator; it only grows when a
/// section is added. Returns the length of the whole cycle.
///
/// A section with no usable length is skipped rather than being clamped: it
/// would otherwise be a boundary the beat can never cross, and the cycle would
/// stop advancing with nothing anywhere saying why.
pub fn section_bounds(sections: &[Section], out: &mut Vec<(f64, usize)>) -> f64 {
    out.clear();
    let mut total = 0.0;
    for (i, s) in sections.iter().enumerate() {
        if !s.on || !(s.beats > 0.0) || !s.beats.is_finite() {
            continue;
        }
        total += s.beats;
        out.push((total, i));
    }
    total
}

/// Which section a beat falls in, as an index into the config's list.
///
/// The beat is reduced into the cycle first, so this answers for a *sounding*
/// beat that a drum voice's offset look-ahead has pushed past the wrap -- the
/// same correction the old two-half toggle needed, generalised.
pub fn section_at(bounds: &[(f64, usize)], beat: f64, cycle: f64) -> Option<usize> {
    if !(cycle > 0.0) || !beat.is_finite() {
        return None;
    }
    let b = beat.rem_euclid(cycle);
    bounds.iter().find(|(end, _)| b < *end).map(|(_, i)| *i)
}
