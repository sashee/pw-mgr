# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/37f4c38b43ed8131f37cea1bbc7c0fb6b7881c30.tar.gz";
  sha256 = "11qix5n9ljdggl67v7gqgx1dlazax11f3vsbciry881fhjr36rhs";
}
