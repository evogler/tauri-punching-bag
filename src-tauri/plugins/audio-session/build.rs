// No commands are exposed to the webview -- the app's Rust calls the Swift
// side directly -- so the permission list is empty. `ios_path` is what makes
// the build compile and link the Swift package when the target is iOS; on the
// Mac nothing here builds any Swift.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
