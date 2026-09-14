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

/// Where each step of the cycle ends, as a running total in beats, paired with
/// the section it plays.
///
/// `order` is the cycle written out -- 1-based section numbers, already
/// expanded by `parseNumberList`, so `1, [2,3]x8` arrives here as sixteen
/// alternating steps after the first. Empty means the sections in the order
/// they are written, which is also what an unfinished field falls back to.
///
/// Written into a caller-owned vector because this runs once per callback and
/// the audio thread never reaches for the allocator; it only grows when the
/// cycle gets longer.
///
/// A step with no usable length is skipped rather than clamped: it would
/// otherwise be a boundary the beat can never cross, and the cycle would stop
/// advancing with nothing anywhere saying why.
pub fn section_bounds(
    sections: &[Section],
    order: &[f64],
    out: &mut Vec<(f64, usize)>,
) -> f64 {
    out.clear();
    let mut total = 0.0;
    let steps = if order.is_empty() {
        sections.len()
    } else {
        order.len()
    };
    for step in 0..steps {
        let i = if order.is_empty() {
            step
        } else {
            let n = order[step];
            if !n.is_finite() {
                continue;
            }
            // Wrapped rather than clamped, so deleting a section cannot leave
            // the order pointing at nothing -- the rule `rowColorFor` already
            // follows for its palette.
            let len = sections.len().max(1) as isize;
            (n.round() as isize - 1).rem_euclid(len) as usize
        };
        let s = match sections.get(i) {
            Some(s) => s,
            None => continue,
        };
        if !s.on || !(s.beats > 0.0) || !s.beats.is_finite() {
            continue;
        }
        total += s.beats;
        out.push((total, i));
    }
    total
}

/// Where the drawn part of the cycle begins, in beats.
///
/// A count-off is a section nobody wants to watch, so the pane's timeline
/// starts after it and the groove's downbeat lands at the top of the first row
/// rather than a count-off's worth in.
///
/// Takes `sections_on` rather than leaving it to the caller because forgetting
/// it is a silent bug and not an obvious one: with the cycle switched off, a
/// leftover hidden section would go on shifting the whole picture by its
/// length, with nothing sounding differently to say why.
pub fn display_start(sections: &[Section], bounds: &[(f64, usize)], sections_on: bool) -> f64 {
    if !sections_on {
        return 0.0;
    }
    bounds
        .iter()
        .find(|(_, i)| sections.get(*i).map_or(false, |s| s.show))
        .map_or(0.0, |(end, i)| {
            end - sections.get(*i).map_or(0.0, |s| s.beats)
        })
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

/// Where each phase of the looper's record cycle ends, as a running total in
/// beats, paired with whether the buffer is being written during it.
///
/// The list alternates and **starts silent**: `32,16,16,16` is 32 beats not
/// recording, 16 recording, 16 not, 16 recording. Starting silent is the
/// owner's own reading of the field, and it is the useful one -- the first
/// thing a record cycle does is leave room for the phrase you are about to
/// play to come back in.
///
/// A list with an *odd* number of usable lengths is walked twice, so it comes
/// back round in the opposite phase. Without that a bare `4` would be four
/// beats of silence for ever and the switch would look broken; with it, one
/// number is exactly the fixed even-length on/off, and a list is the same
/// mechanism written out.
///
/// Written into a caller-owned vector for the same reason `section_bounds` is:
/// this runs once per callback and the audio thread never reaches for the
/// allocator. It only grows when the cycle gets longer.
pub fn record_cycle_bounds(lengths: &[f64], out: &mut Vec<(f64, bool)>) -> f64 {
    out.clear();
    let usable = lengths.iter().filter(|n| n.is_finite() && **n > 0.0).count();
    if usable == 0 {
        return 0.0;
    }
    let passes = if usable % 2 == 0 { 1 } else { 2 };
    let mut total = 0.0;
    let mut recording = false;
    for _ in 0..passes {
        for n in lengths {
            // Skipped rather than clamped, the rule `section_bounds` follows: a
            // zero-length phase is a boundary the beat can never cross, and the
            // cycle would stop advancing with nothing saying why.
            if !n.is_finite() || !(*n > 0.0) {
                continue;
            }
            total += *n;
            out.push((total, recording));
            recording = !recording;
        }
    }
    total
}

/// Whether the looper writes at this beat.
///
/// Reduced into the cycle first, so a *negative* beat lands in the cycle's tail
/// rather than nowhere -- which it is for `buffer_compensation` frames after a
/// restart, since this is asked of the visual clock.
///
/// No usable cycle means record, not silence. A half-typed or nonsense list
/// must not quietly stop the looper taking anything in; the failure people can
/// hear is the safer one.
pub fn recording_at(bounds: &[(f64, bool)], beat: f64, cycle: f64) -> bool {
    if !(cycle > 0.0) || !beat.is_finite() {
        return true;
    }
    let b = beat.rem_euclid(cycle);
    bounds
        .iter()
        .find(|(end, _)| b < *end)
        .map_or(true, |(_, r)| *r)
}
