# The password manager's frontend: the static files the backend serves from `static_dir`. There is no build
# step, so this is a copy of web/public at $out/share/pw-mgr/web.
{
  lib,
  runCommand,
}:
let
  public = lib.fileset.toSource {
    root = ./public;
    fileset = ./public;
  };
in
runCommand "pw-mgr-web" { } ''
  mkdir -p "$out/share/pw-mgr"
  cp -r ${public} "$out/share/pw-mgr/web"
''
