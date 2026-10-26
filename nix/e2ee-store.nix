# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/c4e06dc944acc923f7aed9127e01ac867fdf8b0b.tar.gz";
  sha256 = "1ga1yg3gipc9c0vg3jx7rf81d9bczdmyxz4cmag0iyrjgfny4f8m";
}
