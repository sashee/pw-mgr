# NixOS VM test of the module: the service, the socket's access control, the admin wrapper and the
# sandbox.
#
# The machine is an input, so a host repository runs this against its real configuration, the way
# sashee/nixos-test runs monitoring-platform's harness:
#
#   import "${pw-mgr}/nix/tests/lib.nix" { inherit pkgs; machineModules = [ <host config> ]; }
#
# The harness imports ../module.nix itself (NixOS deduplicates a module imported twice by path) and
# adds only what the checks need: a user in the socket's group, one outside it, and curl.
{
  pkgs,
  machineModules,
}:
pkgs.testers.runNixOSTest {
  name = "pw-mgr";
  # So a host config that sets nixpkgs.config or overlays still evaluates.
  node.pkgsReadOnly = false;
  nodes.machine =
    { config, pkgs, ... }:
    {
      imports = machineModules ++ [ ../module.nix ];
      services.pw-mgr.enable = true;
      users.users.pw-client = {
        isNormalUser = true;
        extraGroups = [ config.services.pw-mgr.group ];
      };
      users.users.pw-outsider.isNormalUser = true;
      environment.systemPackages = [ pkgs.curl ];
    };

  testScript =
    { nodes, ... }:
    let
      cfg = nodes.machine.services.pw-mgr;
    in
    ''
      SOCKET = "${cfg.socketPath}"
      STATE = "/var/lib/pw-mgr"


      def get(path, user):
          return machine.succeed(
              f"su - {user} -c 'curl -sf --unix-socket {SOCKET} http://localhost{path}'"
          )


      def prop(name):
          return machine.succeed(f"systemctl show pw-mgr.service -p {name} --value").strip()


      def wait_until_serving():
          machine.wait_for_unit("pw-mgr.service")
          # Type=simple: the unit is active before the socket is bound.
          machine.wait_for_file(SOCKET)


      wait_until_serving()

      with subtest("the socket's group can reach the backend, nobody else can"):
          assert get("/healthz", "pw-client") == "ok"
          assert "<title>Passwords</title>" in get("/", "pw-client"), "the frontend is served"
          machine.fail(
              f"su - pw-outsider -c 'curl -sf --unix-socket {SOCKET} http://localhost/healthz'"
          )
          machine.fail("su - pw-outsider -c 'ls /run/pw-mgr'")

      with subtest("the admin wrapper runs as the service user"):
          out = machine.succeed("pw-mgr user create alice")
          assert "Created user alice" in out, out
          assert "/#setup=" in machine.succeed("pw-mgr setup-token create alice")
          machine.fail("su - pw-client -c 'pw-mgr user list'")
          # The database and its WAL files belong to the service, or it can no longer write.
          foreign = machine.succeed(f"find {STATE} ! -user pw-mgr").strip()
          assert foreign == "", f"files in {STATE} not owned by pw-mgr:\n{foreign}"

      with subtest("data survives a restart"):
          machine.systemctl("restart pw-mgr.service")
          wait_until_serving()
          assert "alice" in machine.succeed("pw-mgr user list")
          assert get("/healthz", "pw-client") == "ok"

      with subtest("the sandbox applies and doesn't get in the way"):
          assert prop("RestrictAddressFamilies") == "AF_UNIX", prop("RestrictAddressFamilies")
          assert prop("NoNewPrivileges") == "yes"
          assert prop("ProtectSystem") == "strict"
          assert prop("CapabilityBoundingSet") == ""
          assert prop("SystemCallFilter") != ""
          assert prop("NRestarts") == "0", f"restarted {prop('NRestarts')} times"
          journal = machine.succeed("journalctl -u pw-mgr.service --no-pager")
          for marker in ["seccomp", "Operation not permitted", "SIGSYS", "signal=SYS"]:
              assert marker not in journal, f"{marker!r} in the journal:\n{journal}"
          # A directive in the wrong section is dropped with only a warning.
          ignored = machine.succeed("journalctl -b --no-pager | grep -F 'Unknown key' || true")
          assert "pw-mgr" not in ignored, ignored
    '';
}
