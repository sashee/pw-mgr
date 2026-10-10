# NixOS module: the backend serving the password manager on a Unix socket.
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
  settingsFormat = pkgs.formats.toml { };
  configFile = settingsFormat.generate "pw-mgr.toml" cfg.settings;
  backend = [
    (lib.getExe cfg.package)
    "--config"
    configFile
  ];

  cli = pkgs.writeShellScriptBin name ''
    cmd=(${lib.escapeShellArgs backend} "$@")
    if [ "$(${pkgs.coreutils}/bin/id -u)" = 0 ]; then
      exec ${pkgs.util-linux}/bin/runuser -u ${cfg.user} -- "''${cmd[@]}"
    elif [ "$(${pkgs.coreutils}/bin/id -un)" = ${cfg.user} ]; then
      exec "''${cmd[@]}"
    else
      echo "${name}: run as root (e.g. sudo ${name} user list); it switches to the ${cfg.user} user" >&2
      exit 1
    fi
  '';
in
{
  options.services.pw-mgr = {
    enable = lib.mkEnableOption "the pw-mgr password manager backend";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ../backend/package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ../backend/package.nix { }";
      description = "The backend.";
    };

    webPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ../web/package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ../web/package.nix { }";
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
        are set by this module.
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
    services.pw-mgr.settings = {
      socket = cfg.socketPath;
      database = "/var/lib/${name}/backend.sqlite3";
      static_dir = "${cfg.webPackage}/share/pw-mgr/web";
      # Shown in passkey prompts; the app's own title.
      rp_name = lib.mkDefault "Passwords";
    };

    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      description = "pw-mgr backend";
    };
    users.groups.${cfg.group} = { };

    environment.systemPackages = [ cli ];

    systemd.services.${name} = {
      description = "pw-mgr password manager backend";
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        # The backend doesn't notify readiness. Nothing needs it: whatever forwards to the socket
        # connects per request.
        Type = "simple";
        ExecStart = "${lib.escapeShellArgs backend} serve";
        Restart = "on-failure";
        RestartSec = "5s";

        User = cfg.user;
        Group = cfg.group;
        UMask = "0077";
        StateDirectory = name;
        StateDirectoryMode = "0700";
        # The directory's mode and group are the access control: the backend sets 0660 on the socket
        # only after bind().
        RuntimeDirectory = name;
        RuntimeDirectoryMode = "0750";

        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        ProcSubset = "pid";
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        CapabilityBoundingSet = [ "" ];
        SystemCallFilter = [ "@system-service" ];
        SystemCallArchitectures = "native";
        # Unix socket only (backend SPEC §3.1), enforced by the kernel.
        RestrictAddressFamilies = [ "AF_UNIX" ];
      };
    };
  };
}
