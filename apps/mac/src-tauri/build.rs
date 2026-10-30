fn main() {
    tauri_build::build();
    // Tauri embeds the macOS development icon in the executable at compile time.
    println!("cargo:rerun-if-changed=icons");
}
