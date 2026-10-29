# NixOS module: the password manager.
#
#   imports = [ "${pw-mgr}/nix/module.nix" ];
#   services.pw-mgr.enable = true;
#
# Plain module, no flake: the packages are built with the host's own nixpkgs, like
# sashee/monitoring-platform's. The backend and its options come from e2ee-store's nix/lib.nix, at the version
# ./e2ee-store.nix pins. Reaching the socket from off the host (iroh, a reverse proxy) is the host's job; the
# socket's group is what grants access (backend SPEC §3.1).
#
# Admin commands run through the `pw-mgr` wrapper as root, e.g. `sudo pw-mgr user create alice`. It
# switches to the service user itself, so SQLite's WAL files can never end up owned by root.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.pw-mgr;
  name = "pw-mgr";
  e2eeStore = import ./e2ee-store.nix;
  e2ee = import (e2eeStore + "/nix/lib.nix") { inherit config lib pkgs; };
in
{
  # No storageBackends: the vault keeps no offloadable blobs.
  options.services.pw-mgr = removeAttrs (e2ee.options { inherit name; }) [ "storageBackends" ] // {
    enable = lib.mkEnableOption "the pw-mgr password manager backend";

    webPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ../web/package.nix {
        sdk = pkgs.callPackage (e2eeStore + "/sdk/package.nix") { };
      };
      defaultText = lib.literalExpression "pkgs.callPackage ../web/package.nix { sdk = …; }";
      description = "The frontend's static files, served by the backend.";
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      # Shown in passkey prompts; the app's own title.
      { services.pw-mgr.settings.rp_name = lib.mkDefault "Passwords"; }
      (e2ee.config {
        inherit name;
        inherit (cfg) package settings;
        staticDir = "${cfg.webPackage}/share/pw-mgr/web";
      })
    ]
  );
}
