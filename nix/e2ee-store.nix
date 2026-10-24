# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/09ae5b92c87eb6de374ad595c7c67f6cbf15d861.tar.gz";
  sha256 = "1ynlpc62zwbbv1hnr0wdyf18kypdjwy43i2wniqlczx4xmdyrdx1";
}
