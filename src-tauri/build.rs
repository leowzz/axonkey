fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let proto_dir = "../vendor/QuarborHIDFilterUserDriver/SDK/proto";
        let schema = format!("{proto_dir}/hid_user.proto");
        // Compile the schema entirely in Rust; no protoc or C/C++ SDK build.
        let descriptors =
            protox::compile([&schema], [proto_dir]).expect("parse Quarbor HID v3 schema");
        prost_build::compile_fds(descriptors).expect("generate Quarbor HID v3 Rust types");
        println!("cargo:rerun-if-changed={schema}");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/macos_input.m")
            .file("native/macos_audio.m")
            .flag("-fobjc-arc")
            .compile("axonkey_macos_native");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        println!("cargo:rustc-link-lib=framework=AudioToolbox");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=CoreAudio");
        println!("cargo:rustc-link-lib=framework=CoreBluetooth");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=IOKit");
        println!("cargo:rerun-if-changed=native/macos_audio.m");
        println!("cargo:rerun-if-changed=native/macos_pcm_queue.h");
        println!("cargo:rerun-if-changed=native/macos_audio_trace.h");
        println!("cargo:rerun-if-changed=native/macos_input.m");
    }
    tauri_build::build()
}
