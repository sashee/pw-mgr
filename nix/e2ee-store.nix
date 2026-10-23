# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/79f4d29e6ce390023924375f4a98f4d1f1cbcf7f.tar.gz";
  sha256 = "1zh48n6xdc4zsnr92swv4i82y536qmjfxlagjs3ddmysrnndfs88";
}
