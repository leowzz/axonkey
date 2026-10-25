fn main() {
    // Small, bundled Siren7 codec shared by Windows and macOS. No FFmpeg/runtime SDK.
    let siren = "../vendor/libsiren";
    let mut codec = cc::Build::new();
    codec.include(siren);
    for source in ["common", "dct4", "rmlt", "huffman", "decoder", "encoder"] {
        codec.file(format!("{siren}/{source}.c"));
    }
    codec.compile("axonkey_siren7");
    println!("cargo:rerun-if-changed={siren}");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let proto_dir = "../vendor/QuarborUniversalKeyboardDriverInstaller/SDK";
        let schema = format!("{proto_dir}/keyboard.proto");
        // Compile the schema entirely in Rust; no protoc or C/C++ SDK build.
        let descriptors = protox::compile([&schema], [proto_dir])
            .expect("parse Quarbor Universal Keyboard schema");
        prost_build::compile_fds(descriptors)
            .expect("generate Quarbor Universal Keyboard Rust types");
        println!("cargo:rerun-if-changed={schema}");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/macos_input.m")
            .file("native/devices/xiaomi_remote/macos_audio.m")
            .file("native/macos_overlay.m")
            .flag("-fobjc-arc")
            .compile("axonkey_macos_native");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=QuartzCore");
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        println!("cargo:rustc-link-lib=framework=AudioToolbox");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=CoreAudio");
        println!("cargo:rustc-link-lib=framework=CoreBluetooth");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=IOKit");
        println!("cargo:rerun-if-changed=native/devices/xiaomi_remote/macos_audio.m");
        println!("cargo:rerun-if-changed=native/macos_pcm_queue.h");
        println!("cargo:rerun-if-changed=native/devices/xiaomi_remote/macos_audio_trace.h");
        println!("cargo:rerun-if-changed=native/macos_input.m");
        println!("cargo:rerun-if-changed=native/macos_overlay.m");
    }
    tauri_build::build()
}
