# NixOS VM test of the module (../module.nix): e2ee-store's instance test (the service, the socket's access
# control, the admin wrapper and the sandbox) on the `pw-mgr` instance, plus a check that the password manager
# is what it serves.
#
# The machine is an input, so a host repository runs this against its real configuration, the way
# sashee/nixos-test runs monitoring-platform's harness:
#
#   import "${pw-mgr}/nix/tests/lib.nix" { inherit pkgs; machineModules = [ <host config> ]; }
{
  pkgs,
  machineModules,
}:
import (import ../e2ee-store.nix + "/nix/tests/lib.nix") {
  inherit pkgs;
  instance = "pw-mgr";
  machineModules = machineModules ++ [
    ../module.nix
    { services.pw-mgr.enable = true; }
  ];
  extraTestScript = ''
    with subtest("the password manager is served"):
        assert "<title>Passwords</title>" in get("/", CLIENT)
  '';
}
