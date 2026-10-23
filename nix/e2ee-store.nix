# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/6b849cf76a7536b7115dbdfdfe9755bdec49fddc.tar.gz";
  sha256 = "0y17dy588lsw7k4pskgz2x3ic5vj4pv2i8p7j7jacrbk9cgkbs1v";
}
