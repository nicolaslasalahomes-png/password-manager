fn main() {
    // Link the macOS frameworks we call into directly via FFI:
    //   - Security: SecItemAdd / SecItemCopyMatching / SecItemDelete /
    //               SecAccessControlCreateWithFlags (biometric Keychain items)
    //   - LocalAuthentication: LAContext (Touch ID availability check)
    // CoreFoundation is linked transitively by core-foundation-sys.
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=LocalAuthentication");
    }
    tauri_build::build()
}
