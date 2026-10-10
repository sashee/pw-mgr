# Entry point: `nix-build nix` builds both packages and runs every check.
#
#   nix-build nix                          # packages + all checks (what CI runs)
#   nix-build nix -A backend               # the backend (its doCheck runs the Rust suite)
#   nix-build nix -A web                   # the frontend's static files
#   nix-build nix -A checks.web-unit       # the frontend's unit tests
#   nix-build nix -A checks.e2e-flows      # one browser test (also e2e-settings, e2e-import-kdbx)
#
# No flake, like the sibling repositories: the packages are callPackage functions and take the caller's
# nixpkgs, so the one pin lives in ./pkgs.nix.
{
  pkgs ? import ./pkgs.nix { },
}:
let
  backend = pkgs.callPackage ../backend/package.nix { };
  web = pkgs.callPackage ../web/package.nix { };
  checks = import ./checks.nix { inherit pkgs backend; };
in
pkgs.symlinkJoin {
  name = "pw-mgr";
  paths = [
    backend
    web
  ];
  # Interpolating each check registers it as a build input, so this only builds when every check passes.
  postBuild = ''
    : ${pkgs.lib.concatStringsSep " " (map toString (builtins.attrValues checks))}
  '';
  passthru = { inherit backend web checks; };
}
