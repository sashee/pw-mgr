# The checks besides the Rust suite (which runs in the backend package's doCheck):
#
# - lint: rustfmt and clippy (warnings are errors), with the same toolchain the package is built with, so a
#   new lint can only appear with a reviewed bump of nix/pkgs.nix.
# - web-unit: the frontend's Node unit tests, including the KeePass import against pykeepass's sample
#   databases (read from the store).
# - e2e-flows, e2e-settings, e2e-import-kdbx: the browser tests. The backend package behind socat (as the
#   iroh shim reaches it), Chromium with a PRF-capable virtual authenticator. Sandboxed builds, not VMs: none of
#   them needs the network, and Chromium resolves *.localhost to loopback by itself.
{
  pkgs,
  backend,
}:
let
  inherit (pkgs) lib;
  fileset = lib.fileset;
  pykeepassSamples = "${pkgs.python3Packages.pykeepass.src}/tests";

  unitSrc = fileset.toSource {
    root = ../web;
    fileset = fileset.unions [
      ../web/public
      ../web/test/unit
    ];
  };

  # The e2e harness finds web/public relative to itself, so keep the repository layout.
  e2eSrc = fileset.toSource {
    root = ../.;
    fileset = fileset.unions [
      ../web/public
      ../web/test/e2e
    ];
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
        PYKEEPASS_TESTS = pykeepassSamples;
        PYTHONDONTWRITEBYTECODE = "1";
        # Chromium looks for fonts even headless; without a config it warns on every start.
        FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
      }
      ''
        export HOME="$TMPDIR"
        python ${e2eSrc}/web/test/e2e/${script}
        touch "$out"
      '';
in
{
  lint = backend.overrideAttrs (old: {
    pname = "backend-lint";
    nativeBuildInputs = old.nativeBuildInputs ++ [
      pkgs.clippy
      pkgs.rustfmt
    ];
    buildPhase = ''
      runHook preBuild
      cargo fmt --check
      cargo clippy --offline --all-targets -- -D warnings
      runHook postBuild
    '';
    doCheck = false;
    installPhase = "touch $out";
  });

  web-unit =
    pkgs.runCommand "pw-mgr-web-unit"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
        PYKEEPASS_TESTS = pykeepassSamples;
      }
      ''
        cd ${unitSrc}
        node --test "test/unit/**/*.test.js"
        touch "$out"
      '';

  e2e-flows = browserTest "e2e-flows" "test_flows.py";
  e2e-settings = browserTest "e2e-settings" "test_settings.py";
  e2e-import-kdbx = browserTest "e2e-import-kdbx" "test_import_kdbx.py";
}
