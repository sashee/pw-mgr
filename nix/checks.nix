# The checks (the backend's Rust suite and lint are e2ee-store's):
#
# - web-unit: the frontend's Node unit tests, including the KeePass import against pykeepass's sample
#   databases (read from the store), against the web package, so with the SDK it ships.
# - e2e-flows, e2e-settings, e2e-safety, e2e-locking, e2e-import-kdbx, e2e-explorer: the browser tests, on e2ee-store's harness. The backend package
#   behind socat (as the iroh shim reaches it) serves the web package; Chromium with a PRF-capable virtual
#   authenticator. Sandboxed builds, not VMs: none of them needs the network, and Chromium resolves *.localhost
#   to loopback by itself.
# - vm: the NixOS module in a VM (./tests/lib.nix), on a minimal machine. A host repository runs the same test
#   against its own configuration.
{
  pkgs,
  backend,
  sdk,
  web,
}:
let
  inherit (pkgs) lib;
  fileset = lib.fileset;
  pykeepassSamples = "${pkgs.python3Packages.pykeepass.src}/tests";
  static = "${web}/share/pw-mgr/web";

  unitTests = fileset.toSource {
    root = ../web/test/unit;
    fileset = ../web/test/unit;
  };

  e2eTests = fileset.toSource {
    root = ../web/test/e2e;
    fileset = ../web/test/e2e;
  };

  python = pkgs.python3.withPackages (p: [
    p.playwright
    p.pykeepass
  ]);

  browserTest =
    name: script:
    pkgs.runCommand "pw-mgr-${name}"
      {
        nativeBuildInputs = [
          python
          pkgs.chromium
          pkgs.socat
        ];
        BACKEND_BIN = lib.getExe backend;
        STATIC_DIR = static;
        PYTHONPATH = "${sdk}/share/e2ee-store/testing";
        PYKEEPASS_TESTS = pykeepassSamples;
        PYTHONDONTWRITEBYTECODE = "1";
        # Chromium looks for fonts even headless; without a config it warns on every start.
        FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
      }
      ''
        export HOME="$TMPDIR"
        python ${e2eTests}/${script}
        touch "$out"
      '';
in
{
  # The tests find the app relative to themselves (../../public), so rebuild that layout.
  web-unit =
    pkgs.runCommand "pw-mgr-web-unit"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
        PYKEEPASS_TESTS = pykeepassSamples;
      }
      ''
        mkdir -p web/test
        cp -r ${static} web/public
        cp -r ${unitTests} web/test/unit
        cd web
        node --test "test/unit/**/*.test.js"
        touch "$out"
      '';

  e2e-flows = browserTest "e2e-flows" "test_flows.py";
  e2e-settings = browserTest "e2e-settings" "test_settings.py";
  e2e-safety = browserTest "e2e-safety" "test_safety.py";
  e2e-locking = browserTest "e2e-locking" "test_locking.py";
  e2e-import-kdbx = browserTest "e2e-import-kdbx" "test_import_kdbx.py";
  e2e-explorer = browserTest "e2e-explorer" "test_explorer.py";

  vm = import ./tests/lib.nix {
    inherit pkgs;
    machineModules = [ { system.stateVersion = lib.trivial.release; } ];
  };
}
