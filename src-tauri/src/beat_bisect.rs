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
    let subdivisions = if subdivisions.len() < 2 {
        &default_subdivisions
    } else {
        subdivisions
    };
    // the length of the subdivision loop is the last value of config subdivision
    let subdivision_len = subdivisions[subdivisions.len() - 1];
    let beats_per_loop = subdivisions.len() as isize - 1;
    let loop_count = (beat / subdivision_len).floor() as isize;
    let sub_beat = beat - (loop_count as f64 * subdivision_len);
    let bisection = bisect(subdivisions, sub_beat);
    loop_count * beats_per_loop + bisection
}
