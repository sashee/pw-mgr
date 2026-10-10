# Development shell: `nix-shell` at the repository root.
{
  pkgs ? import ./nix/pkgs.nix { },
}:
pkgs.mkShell {
  packages = [
    # local serving: socat forwards a loopback port to the backend's socket
    pkgs.socat
    # frontend unit tests
    pkgs.nodejs
    # end-to-end tests: Playwright drives Nix's Chromium
    # KeePass import tests: pykeepass reads the same files as a reference; argon2-cffi and pycryptodome
    # cross-check the primitives.
    (pkgs.python3.withPackages (p: [
      p.playwright
      p.pykeepass
      p.argon2-cffi
      p.pycryptodome
    ]))
    pkgs.chromium
    pkgs.gnumake
  ];
  # pykeepass's sample databases, used by the KeePass import tests (read from the store, not copied).
  PYKEEPASS_TESTS = "${pkgs.python3Packages.pykeepass.src}/tests";
  # Chromium looks for fonts even headless; without a config it warns on every start.
  FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
}
