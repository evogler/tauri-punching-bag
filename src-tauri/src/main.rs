#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use rand::Rng;
use std::sync::atomic::{AtomicI64, Ordering};
use tauri::State;

#[tauri::command]
fn increment_counter(state: State<AtomicI64>) -> Result<i64, String> {
    let mut n = 0;
    let mut rng = rand::thread_rng();
    for _i in 0..1_000_000 {
        let r = rng.gen();
        if r {
            n += 1;
        }
    }
    Ok(state.fetch_add(n, Ordering::SeqCst) + n)
}

#[tauri::command]
fn random_array() -> Result<Vec<i32>, String> {
    let mut v = Vec::new();
    let mut rng = rand::thread_rng();
    for i in 0..10000 {
        let a: i32 = rng.gen();
        let b: i32 = ((a % 12) + 12) % 12;
        v.push(b);
    }
    // println!("{:?}", v);
    Ok(v)
}

#[tauri::command]
fn reset_counter(state: State<AtomicI64>) -> Result<i64, String> {
    Ok(state.fetch_and(0, Ordering::SeqCst))
}

fn main() {
    tauri::Builder::default()
        .manage(AtomicI64::from(5))
        .invoke_handler(tauri::generate_handler![
            increment_counter,
            reset_counter,
            random_array,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
