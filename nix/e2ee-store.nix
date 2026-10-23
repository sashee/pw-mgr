# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/0de7bfbf635054ad11eb4d594ae16d9f7fb9ffd4.tar.gz";
  sha256 = "1f24dwxaym7bcj2lq856j8xz53kznp4vkwsacdi2m4cb28z6kk1c";
}
