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
