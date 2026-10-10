# NixOS module: the password manager, as an instance of e2ee-store's module (nix/module.nix there) named `pw-mgr`.
#
#   imports = [ "${pw-mgr}/nix/module.nix" ];
#   services.pw-mgr.enable = true;
#
# Plain module, no flake: the packages are built with the host's own nixpkgs, like
# sashee/monitoring-platform's. Reaching the socket from off the host (iroh, a reverse proxy) is the
# host's job; the socket's group is what grants access (backend SPEC §3.1).
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
  settingsFormat = pkgs.formats.toml { };
in
{
  imports = [ (e2eeStore + "/nix/module.nix") ];

  options.services.pw-mgr = {
    enable = lib.mkEnableOption "the pw-mgr password manager backend";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage (e2eeStore + "/backend/package.nix") { };
      defaultText = lib.literalExpression "pkgs.callPackage \"\${e2ee-store}/backend/package.nix\" { }";
      description = "The backend.";
    };

    webPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ../web/package.nix {
        sdk = pkgs.callPackage (e2eeStore + "/sdk/package.nix") { };
      };
      defaultText = lib.literalExpression "pkgs.callPackage ../web/package.nix { sdk = …; }";
      description = "The frontend's static files, served by the backend.";
    };

    settings = lib.mkOption {
      type = lib.types.submodule { freeformType = settingsFormat.type; };
      default = { };
      example = {
        public_hosts = [ "pw.example.com" ];
        session_ttl = "8h";
      };
      description = ''
        The backend's configuration file (backend SPEC §10). `socket`, `database` and `static_dir`
        are set by e2ee-store's module.
      '';
    };

    socketPath = lib.mkOption {
      type = lib.types.str;
      default = "/run/${name}/backend.sock";
      readOnly = true;
      description = "The socket the backend listens on, for whatever forwards to it.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = name;
      readOnly = true;
      description = "User the backend runs as; it owns the data in /var/lib/pw-mgr.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = name;
      readOnly = true;
      description = "Group that may connect to {option}`socketPath`.";
    };
  };

  config = lib.mkIf cfg.enable {
    services.e2ee-store.instances.${name} = {
      inherit (cfg) package;
      staticDir = "${cfg.webPackage}/share/pw-mgr/web";
      settings = lib.mkMerge [
        # Shown in passkey prompts; the app's own title.
        { rp_name = lib.mkDefault "Passwords"; }
        cfg.settings
      ];
    };
  };
}
