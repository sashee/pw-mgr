# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/07e5440b56631ce47cf33f2aa975eb2383ac8604.tar.gz";
  sha256 = "042jcdhrln4w0rnqa9qz191dazl0hv05rlqpnfssc0351vc0rhsa";
}
